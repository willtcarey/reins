import { posix } from "node:path";
import type { ExecutionErrorCode, FileInfo, ShellExecOptions, ShellExecResult, ShellOutputUpdate } from "@earendil-works/pi-agent-core";
import { APPLICATION_ERROR, WRITE_CHUNK_BYTES, execRecord, nodeError, RpcFailure, type ExecRecord, type FileErrorData } from "@reins/node-protocol";
import type { Spawn } from "../git.js";
import type { NodeClient } from "../state.js";

/** Bounds the node's answer to a call, not the run of a command or process it accepts. */
export const NODE_CALL_TIMEOUT_MS = 10_000;
/** How long a file operation with an unknown outcome is resent, from its first such failure. */
export const RETRY_WINDOW_MS = 30_000;
/** The node's grace period (`EXEC_GRACE_MS`): it keeps a command this long, so looking longer cannot find it. */
export const EXEC_REATTACH_WINDOW_MS = 60_000;
const RETRY_BACKOFF_MS = { initial: 50, max: 1_000 };
const backoff = (attempt: number) => Math.min(RETRY_BACKOFF_MS.max, RETRY_BACKOFF_MS.initial * 2 ** attempt);
/** Pi's bound on a command's timeout. */
const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1000;

export interface NodeDirClientOptions {
  cwd: string;
  /** A client that outlives its app's hub (a session's) takes `currentAppNode`'s. A call it rejects
   * `unavailable` may be resent; any other rejection (the node was removed) is final. */
  node: NodeClient;
  /** Wait for an unreachable node and resend (the default). `false` fails at once, for callers answering
   * now (a browser's request, a script). */
  waitForNode?: boolean;
  /** `true` while calls wait for the node: nothing is in flight, so a run may pause there. */
  onWaiting?(waiting: boolean): void;
  retryWindowMs?: number;
  reattachWindowMs?: number;
}

export interface CallOptions { signal?: AbortSignal }

/** The file's own failure (missing, a directory, …), not a failure to reach the node. */
export class NodeFileError extends Error {
  readonly name = "NodeFileError";
  constructor(readonly code: FileErrorData["code"], message: string, readonly path?: string) {
    super(message);
  }
}

/** A command that did not exit. An aborted one rejects with its signal's reason instead. */
export class NodeCommandError extends Error {
  readonly name = "NodeCommandError";
  constructor(readonly code: ExecutionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

const refusal = (error: unknown) => error instanceof RpcFailure && error.code === APPLICATION_ERROR ? nodeError.safeParse(error.data).data : undefined;
/** Worth resending: the node was not reached (or no app was current, a reload's gap), refused it while
 * pausing to restart, or the outcome is unknown. */
const unreachable = (error: unknown) => error instanceof RpcFailure && error.code === "unavailable" || refusal(error)?.code === "unavailable" && refusal(error)?.retryable === true;
/** Certainly not run, so it may be resent even when it is not safe to repeat. */
const notRun = (error: unknown) => unreachable(error) && !(error instanceof RpcFailure && error.outcome === "unknown");
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>(resolve => {
  const timer = setTimeout(done, ms);
  signal?.addEventListener("abort", done, { once: true });
  function done() { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); }
});
const OUTCOME_UNKNOWN = "The command's outcome is unknown";

async function bytesOf(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const part of body) parts.push(part);
  return Buffer.concat(parts);
}

/** `attach`: pick up the command an earlier server process already sent under `execId` instead of sending it. */
export interface CommandCall { execId: string; attach: boolean }

export interface ExecOptions extends Omit<ShellExecOptions, "onUpdate">, CallOptions {
  call?: CommandCall;
  /** Throwing kills the command, which then fails `callback_error`. */
  onUpdate?(update: ShellOutputUpdate): void;
}

type FileAnswer<T> = { ok: true; value: T } | { ok: false; error: FileErrorData };
export interface FileRange { offset?: number; maxBytes?: number }

export class NodeDirClient {
  readonly cwd: string;
  private readonly node: NodeClient;
  private readonly retryWindowMs: number;
  private readonly reattachWindowMs: number;
  private readonly waitForNode: boolean;
  private readonly onWaiting: (waiting: boolean) => void;
  private readonly running = new Set<string>();
  private detached = false;

  constructor(options: NodeDirClientOptions) {
    this.cwd = options.cwd;
    this.node = options.node;
    this.retryWindowMs = options.retryWindowMs ?? RETRY_WINDOW_MS;
    this.reattachWindowMs = options.reattachWindowMs ?? EXEC_REATTACH_WINDOW_MS;
    this.waitForNode = options.waitForNode ?? true;
    this.onWaiting = options.onWaiting ?? (() => {});
  }

  /**
   * When waiting for the node, resends `call` while it certainly did not run, however long, and while its
   * outcome is unknown for `unknownWindowMs` from the first such failure (never without it). `windowMs`
   * caps all resending from the start, for what the node keeps only that long.
   */
  private async onNode<T>(call: (node: NodeClient) => Promise<T>, { signal, unknownWindowMs, windowMs }: { signal?: AbortSignal; unknownWindowMs?: number; windowMs?: number }): Promise<T> {
    const deadline = windowMs === undefined ? Infinity : Date.now() + windowMs;
    let unknownDeadline: number | undefined;
    let waiting = false;
    const wait = (now: boolean) => { if (now !== waiting) this.onWaiting(waiting = now); };
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          if (this.node.connected) wait(false);
          return await call(this.node);
        } catch (error) {
          if (!this.waitForNode || !unreachable(error) || signal?.aborted || Date.now() >= deadline) throw error;
          if (!notRun(error)) {
            if (unknownWindowMs === undefined) throw error;
            unknownDeadline ??= Date.now() + unknownWindowMs;
            if (Date.now() >= unknownDeadline) throw error;
          }
          wait(true);
          await sleep(backoff(attempt), signal);
        }
      }
    } finally {
      wait(false);
    }
  }

  /** Resends `work` as a file operation is resent, for work of several calls a dropped link may cut off
   * midway (e.g. checking out a branch): it must be safe to rerun whole after running in part. */
  async repeat<T>(work: () => Promise<T>, { signal }: CallOptions = {}): Promise<T> {
    try { return await this.onNode(() => work(), { signal, unknownWindowMs: this.retryWindowMs }); }
    catch (error) { throw signal?.aborted ? signal.reason : error; }
  }

  async connectedNode({ signal }: CallOptions = {}): Promise<NodeClient> {
    try {
      return await this.onNode(async node => {
        if (!node.connected) throw new RpcFailure("unavailable", "Node not connected");
        return node;
      }, { signal });
    } catch (error) { throw signal?.aborted ? signal.reason : error; }
  }

  /** File operations are safe to repeat, so one with an unknown outcome is resent. */
  private async file<T>(call: (node: NodeClient, signal?: AbortSignal) => Promise<FileAnswer<T>>, { signal }: CallOptions): Promise<T> {
    let answer: FileAnswer<T>;
    try {
      signal?.throwIfAborted();
      answer = await this.onNode(node => call(node, signal), { signal, unknownWindowMs: this.retryWindowMs });
    } catch (error) {
      throw signal?.aborted ? signal.reason : error;
    }
    if (answer.ok) return answer.value;
    throw new NodeFileError(answer.error.code, answer.error.message, answer.error.path);
  }

  private at(path: string) { return { cwd: this.cwd, path }; }

  /** Resolves `~` too; the path need not exist. */
  absolutePath(path: string, options: CallOptions = {}): Promise<string> {
    return this.file((node, signal) => node.request("fs.absolutePath", this.at(path), { signal, timeoutMs: NODE_CALL_TIMEOUT_MS }), options);
  }

  canonicalPath(path: string, options: CallOptions = {}): Promise<string> {
    return this.file((node, signal) => node.request("fs.canonicalPath", this.at(path), { signal, timeoutMs: NODE_CALL_TIMEOUT_MS }), options);
  }

  /** `lstat`: a symlink is not followed. */
  fileInfo(path: string, options: CallOptions = {}): Promise<FileInfo> {
    return this.file((node, signal) => node.request("fs.info", this.at(path), { signal, timeoutMs: NODE_CALL_TIMEOUT_MS }), options);
  }

  listDir(path: string, options: CallOptions = {}): Promise<FileInfo[]> {
    return this.file(async (node, signal) => {
      const answer = await node.request("fs.list", this.at(path), { signal, timeoutMs: NODE_CALL_TIMEOUT_MS });
      return answer.ok ? { ok: true, value: answer.value.entries.map(entry => ({ ...entry, path: posix.join(answer.value.path, entry.name) })) } : answer;
    }, options);
  }

  private async openRead(node: NodeClient, path: string, { offset = 0, maxBytes }: FileRange, signal?: AbortSignal): Promise<FileAnswer<{ size: number; body: ReadableStream<Uint8Array> }>> {
    const range = { ...(offset === 0 ? {} : { offset }), ...(maxBytes === undefined ? {} : { maxBytes }) };
    const { result, body } = await node.openStream("fs.read", { ...this.at(path), ...range }, { signal, timeoutMs: NODE_CALL_TIMEOUT_MS });
    if (result.ok) return { ok: true, value: { size: result.value.size, body } };
    void body.cancel().catch(() => undefined);
    return result;
  }

  /** Only opening is resent; a stream cut off once open errors. */
  readFileStream(path: string, { signal, ...range }: FileRange & CallOptions = {}): Promise<{ size: number; body: ReadableStream<Uint8Array> }> {
    return this.file((node, callSignal) => this.openRead(node, path, range, callSignal), { signal });
  }

  /** Holds the bytes, so read a large file in ranges. A read cut short is resent whole. */
  readFileRange(path: string, { signal, ...range }: FileRange & CallOptions = {}): Promise<{ size: number; bytes: Uint8Array }> {
    return this.file(async (node, callSignal) => {
      const opened = await this.openRead(node, path, range, callSignal);
      if (!opened.ok) return opened;
      const { size, body } = opened.value;
      const bytes = await bytesOf(body);
      const expected = Math.max(0, Math.min(size - (range.offset ?? 0), range.maxBytes ?? Infinity));
      if (expected !== bytes.byteLength) throw new RpcFailure("unavailable", `Read ${bytes.byteLength} of ${expected} bytes`, "unknown");
      return { ok: true, value: { size, bytes } };
    }, { signal });
  }

  /** As Pi's write tool: creates its directories, replaces a file there. */
  writeFile(path: string, content: string | Uint8Array, options: CallOptions = {}): Promise<void> {
    const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    return this.writeFileFrom(path, (async function* () { yield bytes; })(), options);
  }

  /** Holds at most a chunk and a piece, so a file of any size. Nothing is at `path` until the last chunk. */
  async writeFileFrom(path: string, source: AsyncIterable<Uint8Array>, options: CallOptions = {}): Promise<void> {
    const writeId = crypto.randomUUID();
    let offset = 0;
    const send = async (chunk: Buffer, last: boolean) => {
      const sent = { ...this.at(path), writeId, offset, data: chunk.toString("base64"), last };
      await this.file((node, signal) => node.request("fs.write", sent, { signal, timeoutMs: NODE_CALL_TIMEOUT_MS }), options);
      offset += chunk.byteLength;
    };
    // A chunk is sent once more bytes follow it, so the last is known to be last.
    let pending = Buffer.alloc(0);
    for await (const piece of source) {
      pending = Buffer.concat([pending, piece]);
      while (pending.byteLength > WRITE_CHUNK_BYTES) {
        await send(pending.subarray(0, WRITE_CHUNK_BYTES), false);
        pending = pending.subarray(WRITE_CHUNK_BYTES);
      }
    }
    await send(pending, true);
  }

  /** A start is resent only while it certainly did not run: a process is not safe to repeat. `signal`
   * stops only the start; cancelling stdout kills a started process. */
  spawner({ signal }: CallOptions = {}): Spawn {
    return async (argv, { env, binary } = {}) => {
      const input = { cwd: this.cwd, argv, ...(env ? { env } : {}), ...(binary ? { binary } : {}) };
      let opened;
      try { opened = await this.onNode(node => node.openStream("process.run", input, { signal, timeoutMs: NODE_CALL_TIMEOUT_MS }), { signal }); }
      catch (error) { throw signal?.aborted ? signal.reason : error; }
      const exited = opened.ended.then(exit => exit ?? Promise.reject(new Error(`Process stream ended without an exit: ${argv[0]}`)));
      // A consumer that cancels stdout need not await the exit.
      exited.catch(() => undefined);
      return { stdout: opened.body, exited };
    };
  }

  /** The node refuses an `execId` it already has. A dropped stream is picked up again from the last record
   * taken (`pi.execAttach`); a command the node no longer knows fails `unknown`. */
  async exec(command: string, { call = { execId: crypto.randomUUID(), attach: false }, ...options }: ExecOptions = {}): Promise<ShellExecResult> {
    const { signal, timeout } = options;
    signal?.throwIfAborted();
    if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) throw new NodeCommandError("timeout", "Invalid timeout: must be a finite number of seconds");
    if (timeout !== undefined && timeout > MAX_TIMEOUT_SECONDS) throw new NodeCommandError("timeout", `Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
    this.running.add(call.execId);
    try { return await this.runExec(call, command, options); }
    finally { this.running.delete(call.execId); }
  }

  private async runExec({ execId, attach }: CommandCall, command: string, { signal, onUpdate, ...sent }: Omit<ExecOptions, "call">): Promise<ShellExecResult> {
    const aborted = (): unknown => signal?.reason;
    let callbackError: NodeCommandError | undefined;
    const update = (value: ShellOutputUpdate) => {
      if (callbackError || !onUpdate) return;
      try { onUpdate(value); }
      catch (error) {
        callbackError = new NodeCommandError("callback_error", messageOf(error), { cause: error });
        void this.kill(execId);
      }
    };
    // An abort whose kill cannot reach the node, or kills nothing (detached), stops reading instead.
    let reading: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const stopReading = () => { void reading?.cancel().catch(() => undefined); };
    const onAbort = () => {
      if (this.detached) stopReading();
      else void this.kill(execId).then(killed => { if (!killed) stopReading(); });
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      let taken = 0;
      let body: ReadableStream<Uint8Array> | undefined;
      if (!attach) {
        try {
          // Resent only while certainly not run; an unknown outcome is picked up by attaching.
          body = (await this.onNode(node => node.openStream("pi.exec", { cwd: this.cwd, execId, command, options: sent }, { signal, timeoutMs: NODE_CALL_TIMEOUT_MS }),
            { signal })).body;
        } catch (error) {
          if (signal?.aborted) throw aborted();
          if (!(error instanceof RpcFailure && error.outcome === "unknown")) throw new NodeCommandError("spawn_error", messageOf(error), { cause: error });
        }
      }
      for (;;) {
        if (body) {
          if (signal?.aborted) { void body.cancel().catch(() => undefined); throw aborted(); }
          reading = body.getReader();
          const read = await readRecords(reading, record => {
            taken += record.bytes;
            if ("update" in record.value) update(record.value.update);
          });
          if (read.exit) {
            if (callbackError) throw callbackError;
            const { exit } = read;
            if (!exit.ok && exit.error.code === "timeout") throw new NodeCommandError("timeout", exit.error.message);
            if (signal?.aborted) throw aborted();
            if (!exit.ok) throw new NodeCommandError(exit.error.code, exit.error.message);
            return exit.value;
          }
          if (read.malformed) { void this.kill(execId); throw new NodeCommandError("unknown", `${OUTCOME_UNKNOWN}: ${read.malformed}`); }
        }
        if (signal?.aborted) throw aborted();
        if (callbackError) throw callbackError;
        try {
          const attached = await this.onNode(node => node.openStream("pi.execAttach", { execId, offset: taken }, { signal, timeoutMs: NODE_CALL_TIMEOUT_MS }),
            { signal, windowMs: this.reattachWindowMs, unknownWindowMs: this.reattachWindowMs });
          if (attached.result.view) update({ kind: "replace", output: attached.result.view });
          taken = attached.result.offset;
          body = attached.body;
        } catch (error) {
          if (signal?.aborted) throw aborted();
          const why = refusal(error)?.code === "not_found"
            ? `the node does not have it (it restarted, or the server stayed away past its grace period${attach ? ", or it was never sent" : ""})`
            : messageOf(error);
          throw new NodeCommandError("unknown", `${OUTCOME_UNKNOWN}: ${why}`, { cause: error });
        }
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Whether the node no longer has the command: killed, or not known there. */
  private async kill(execId: string): Promise<boolean> {
    try {
      await this.onNode(node => node.request("pi.execKill", { execId }, { timeoutMs: NODE_CALL_TIMEOUT_MS }), { windowMs: NODE_CALL_TIMEOUT_MS, unknownWindowMs: NODE_CALL_TIMEOUT_MS });
      return true;
    } catch (error) {
      return refusal(error)?.code === "not_found";
    }
  }

  /** Never throws. */
  async cleanup(): Promise<void> {
    if (this.detached) return;
    await Promise.allSettled([...this.running].map(execId => this.kill(execId)));
  }

  /** For a suspending runtime: its commands keep running for the next server process to attach to (within
   * the node's grace period). An abort then only stops reading, and `cleanup` kills nothing. */
  detach(): void {
    this.detached = true;
  }
}

/** Neither field: the stream stopped (dropped, failed or ended) before an exit record. */
async function readRecords(reader: ReadableStreamDefaultReader<Uint8Array>, take: (record: { value: ExecRecord; bytes: number }) => void): Promise<{ exit?: Extract<ExecRecord, { exit: unknown }>["exit"]; malformed?: string }> {
  const decoder = new TextDecoder();
  let pending: Buffer = Buffer.alloc(0);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return {};
      pending = Buffer.concat([pending, value]);
      for (let newline = pending.indexOf(10); newline !== -1; newline = pending.indexOf(10)) {
        const line = pending.subarray(0, newline);
        pending = pending.subarray(newline + 1);
        let parsed;
        try { parsed = execRecord.safeParse(JSON.parse(decoder.decode(line))); } catch { parsed = undefined; }
        if (!parsed?.success) return { malformed: "a malformed output record" };
        take({ value: parsed.data, bytes: line.byteLength + 1 });
        if ("exit" in parsed.data) return { exit: parsed.data.exit };
      }
    }
  } catch {
    return {};
  } finally {
    reader.releaseLock();
  }
}

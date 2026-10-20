/**
 * A client for one directory on a node (ADR-029): its files, shell commands and processes, over the node's
 * `fs.*`, `pi.exec` and `process.run` through a `NodeClient`, one method for each; files and commands
 * answer with what Pi's local environment returns there. The one way the server reaches a directory on a
 * node: a session's checkout (Pi's tools and the discovery of its context files and skills, through
 * `PiNodeEnv`, Pi's `ExecutionEnv` over it, and its preparation), a source's checkout (`SourceModel`: its
 * git, its files for a browser), a node's machine (`NodeHost`).
 *
 * A call returns its value. It throws a `NodeFileError` for the node's refusal of a file operation (the
 * file's own failure: missing, a directory, …) and a `NodeCommandError` for a command that did not exit;
 * any other failure (the node was not reached, or did not answer) is thrown as it came, an `RpcFailure`.
 * Aborting a call's `signal` rejects it with the signal's reason.
 *
 * It holds no link: its `NodeClient` calls over the node's link at the time of each call (a link drops
 * when the app reloads, the server or the node restarts, or the network fails). Every call waits
 * `NODE_CALL_TIMEOUT_MS` for the node's answer (accepting a command or a process; their run is not bounded).
 * A client either waits for its node (the default, a session's) or answers now (`waitForNode: false`: a
 * browser's request, a script). Waiting, a call that certainly did not run (its node is not connected, no
 * app is current, or it refuses it while it pauses to restart) waits for the node however long, until the
 * call is aborted or the node is removed, and short file operations, safe to repeat, are sent again when
 * their outcome is unknown, within a bound. Answering now, it does neither. A command keeps running on the node
 * through a dropped link: the client picks it up again by its ID from the last output it took
 * (`pi.execAttach`), feeding the same call, until the node no longer knows it (it restarted, or the
 * server stayed away past its grace period), which makes the call's outcome unknown. Aborting a call
 * kills its command (`pi.execKill`), unless the client was detached (its runtime is suspended, the
 * server going away): then the command goes on, and the next server process picks it up by the ID its tool
 * call recorded (`exec` with `attach`).
 */
import { posix } from "node:path";
import type { ExecutionErrorCode, FileInfo, ShellExecOptions, ShellExecResult, ShellOutputUpdate } from "@earendil-works/pi-agent-core";
import { APPLICATION_ERROR, WRITE_CHUNK_BYTES, execRecord, nodeError, RpcFailure, type ExecRecord, type FileErrorData } from "@reins/node-protocol";
import type { Spawn } from "../git.js";
import type { NodeClient } from "../state.js";

/** Bound on the node answering one call: a file operation, opening a read (its bytes follow on its
 * stream), accepting a command, a request for its output or a process (not on its run). */
export const NODE_CALL_TIMEOUT_MS = 10_000;
/** How long a file operation whose outcome is unknown after it was sent (its link dropped, or its answer
 * did not come in time) is sent again, from the first such failure, by a client that waits for its node. */
export const RETRY_WINDOW_MS = 30_000;
/** How long a command whose stream dropped is looked for again: the node keeps it this long (its grace
 * period, `EXEC_GRACE_MS` on the node), so looking longer cannot find it. */
export const EXEC_REATTACH_WINDOW_MS = 60_000;
const RETRY_BACKOFF_MS = { initial: 50, max: 1_000 };
const backoff = (attempt: number) => Math.min(RETRY_BACKOFF_MS.max, RETRY_BACKOFF_MS.initial * 2 ** attempt);
/** Pi's bound on a command's timeout. */
const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1000;

export interface NodeDirClientOptions {
  /** The directory's path on the node (a checkout's): relative paths resolve against it. */
  cwd: string;
  /** The node: `NodeHub.get`'s, or `currentAppNode`'s for a client that outlives its app's hub (a
   * session's). A call it rejects `unavailable` is one the node could not be reached for now; any other
   * rejection (the node was removed) is final. */
  node: NodeClient;
  /** Whether a call waits for the node (the default): one that certainly did not run (the node is not
   * connected, or refuses it while it pauses to restart) is sent again once it can be, and a file operation
   * whose outcome is unknown is sent again within `retryWindowMs`. Without waiting, a call fails at once
   * (with the node's `unavailable` failure when it was not run) and nothing is sent again: for a caller
   * answering now (a browser's request, a script). */
  waitForNode?: boolean;
  /** Told when calls start waiting for the node (`true`: nothing is being sent, so a run may pause there)
   * and when they are sent once more (`false`). */
  onWaiting?(waiting: boolean): void;
  /** `RETRY_WINDOW_MS` by default. */
  retryWindowMs?: number;
  /** `EXEC_REATTACH_WINDOW_MS` by default. */
  reattachWindowMs?: number;
}

/** A call's options: aborting `signal` rejects it with the signal's reason (a command is killed). */
export interface CallOptions { signal?: AbortSignal }

/** The node's refusal of a file operation: the file's own failure (missing, a directory, …), with Pi's
 * code, not a failure to reach the node. */
export class NodeFileError extends Error {
  readonly name = "NodeFileError";
  constructor(readonly code: FileErrorData["code"], message: string, readonly path?: string) {
    super(message);
  }
}

/** A command that did not exit: its timeout (or an invalid one), its start refused (`spawn_error`), its
 * outcome unknown (`unknown`), its `onUpdate` throwing (`callback_error`), or the node's own execution
 * error, with Pi's code. An aborted command rejects with its signal's reason instead. */
export class NodeCommandError extends Error {
  readonly name = "NodeCommandError";
  constructor(readonly code: ExecutionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

/** The node's definite refusal of a call, if it was one. */
const refusal = (error: unknown) => error instanceof RpcFailure && error.code === APPLICATION_ERROR ? nodeError.safeParse(error.data).data : undefined;
/** Whether a failed call may be sent again: the node was not reachable (or no app was current to reach it
 * through, a reload's gap) or refused it for now (it is pausing to restart), or the outcome is unknown. */
const unreachable = (error: unknown) => error instanceof RpcFailure && error.code === "unavailable" || refusal(error)?.code === "unavailable" && refusal(error)?.retryable === true;
/** Whether a failed call was certainly not run, so it may be sent again even if it is not safe to repeat. */
const notRun = (error: unknown) => unreachable(error) && !(error instanceof RpcFailure && error.outcome === "unknown");
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>(resolve => {
  const timer = setTimeout(done, ms);
  signal?.addEventListener("abort", done, { once: true });
  function done() { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); }
});
const OUTCOME_UNKNOWN = "The command's outcome is unknown";

/** All of a stream's bytes. */
async function bytesOf(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const part of body) parts.push(part);
  return Buffer.concat(parts);
}

/** The command of a tool call, under the ID the call recorded before it was sent: `attach` picks up the
 * one already sent under it (by an earlier server process) instead of sending it. */
export interface CommandCall { execId: string; attach: boolean }

export interface ExecOptions extends Omit<ShellExecOptions, "onUpdate">, CallOptions {
  /** The ID to run it under, and whether to pick up the command already sent under it; a fresh ID, sent,
   * by default. */
  call?: CommandCall;
  /** Told each update to the command's output view, in order. One that throws kills the command, which
   * then fails `callback_error`. */
  onUpdate?(update: ShellOutputUpdate): void;
}

/** A file operation's answer on the wire. */
type FileAnswer<T> = { ok: true; value: T } | { ok: false; error: FileErrorData };
/** Where in a file a read starts (`offset`, 0 by default) and how many bytes it takes at most (`maxBytes`,
 * all of them by default). */
export interface FileRange { offset?: number; maxBytes?: number }

export class NodeDirClient {
  readonly cwd: string;
  private readonly node: NodeClient;
  private readonly retryWindowMs: number;
  private readonly reattachWindowMs: number;
  private readonly waitForNode: boolean;
  private readonly onWaiting: (waiting: boolean) => void;
  /** Commands this client started that have not ended. */
  private readonly running = new Set<string>();
  /** Set by `detach`: its commands outlive it. */
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
   * Runs `call` on the node; again, after a short backoff, until `signal` aborts, if the client waits for
   * its node (`waitForNode`):
   * - while it certainly did not run (`notRun`: the node is not connected, or refuses it while it pauses
   *   to restart), however long;
   * - while its outcome is unknown after it was sent, for `unknownWindowMs` from the first such failure
   *   (none: it is not sent again).
   * With `windowMs`, it is sent again for any of these only until `windowMs` has passed from the start
   * (what the node keeps only that long). Any other failure, a removed node's included, is thrown. While it
   * waits to send it again, the client says it waits (`onWaiting`).
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

  /**
   * Runs `work`, which is safe to run again whole (it may have run in part), again while it fails because
   * the node was unreachable, whether or not what it sent ran: however long while it certainly did not run,
   * within the retry window from the first failure whose outcome is unknown (as a file operation is sent
   * again). For work of several calls a dropped link may cut off midway, e.g. checking out a branch. Any
   * other failure, and any failure of a client that does not wait for its node, is thrown.
   */
  async repeat<T>(work: () => Promise<T>, { signal }: CallOptions = {}): Promise<T> {
    try { return await this.onNode(() => work(), { signal, unknownWindowMs: this.retryWindowMs }); }
    catch (error) { throw signal?.aborted ? signal.reason : error; }
  }

  /** The node, once it is connected: waiting for it as a call does (or failing at once, `unavailable`, when
   * the client does not wait). */
  async connectedNode({ signal }: CallOptions = {}): Promise<NodeClient> {
    try {
      return await this.onNode(async node => {
        if (!node.connected) throw new RpcFailure("unavailable", "Node not connected");
        return node;
      }, { signal });
    } catch (error) { throw signal?.aborted ? signal.reason : error; }
  }

  /** One file operation on the node (`call`, with the call's signal), sent again as `onNode` sends a call
   * safe to repeat; its value, or its file error thrown as a `NodeFileError`. */
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

  /** The call's params for `path`. */
  private at(path: string) { return { cwd: this.cwd, path }; }

  /** `path` resolved against the directory (and `~`, the node's home), whether or not it exists. */
  absolutePath(path: string, options: CallOptions = {}): Promise<string> {
    return this.file((node, signal) => node.request("fs.absolutePath", this.at(path), { signal, timeoutMs: NODE_CALL_TIMEOUT_MS }), options);
  }

  /** An existing path with its symlinks resolved. */
  canonicalPath(path: string, options: CallOptions = {}): Promise<string> {
    return this.file((node, signal) => node.request("fs.canonicalPath", this.at(path), { signal, timeoutMs: NODE_CALL_TIMEOUT_MS }), options);
  }

  /** What `lstat` says of a path (a symlink is not followed). */
  fileInfo(path: string, options: CallOptions = {}): Promise<FileInfo> {
    return this.file((node, signal) => node.request("fs.info", this.at(path), { signal, timeoutMs: NODE_CALL_TIMEOUT_MS }), options);
  }

  /** A directory's children. */
  listDir(path: string, options: CallOptions = {}): Promise<FileInfo[]> {
    return this.file(async (node, signal) => {
      const answer = await node.request("fs.list", this.at(path), { signal, timeoutMs: NODE_CALL_TIMEOUT_MS });
      return answer.ok ? { ok: true, value: answer.value.entries.map(entry => ({ ...entry, path: posix.join(answer.value.path, entry.name) })) } : answer;
    }, options);
  }

  /** Opens `fs.read` of `range` of the file: its size and a stream of its bytes. A stream the node refused
   * (its answer is a file error) is cancelled. */
  private async openRead(node: NodeClient, path: string, { offset = 0, maxBytes }: FileRange, signal?: AbortSignal): Promise<FileAnswer<{ size: number; body: ReadableStream<Uint8Array> }>> {
    const range = { ...(offset === 0 ? {} : { offset }), ...(maxBytes === undefined ? {} : { maxBytes }) };
    const { result, body } = await node.openStream("fs.read", { ...this.at(path), ...range }, { signal, timeoutMs: NODE_CALL_TIMEOUT_MS });
    if (result.ok) return { ok: true, value: { size: result.value.size, body } };
    void body.cancel().catch(() => undefined);
    return result;
  }

  /** The file's size and a stream of its bytes from `offset` (none past its end), at most `maxBytes` of
   * them, to pass on as they come (to a browser's response): only opening it is sent again, as a file
   * operation; a stream cut off once open errors. */
  readFileStream(path: string, { signal, ...range }: FileRange & CallOptions = {}): Promise<{ size: number; body: ReadableStream<Uint8Array> }> {
    return this.file((node, callSignal) => this.openRead(node, path, range, callSignal), { signal });
  }

  /** The file's size and its bytes from `offset` (none past its end), at most `maxBytes` of them, held: a
   * file too large to hold, or whose stream the caller cannot keep up with, is read in ranges. A read whose
   * bytes did not all arrive is read again, as a file operation. */
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

  /** Writes the file whole (UTF-8 for text), as Pi's write tool does: its directories created, a file
   * there replaced. Sent in chunks (`WRITE_CHUNK_BYTES`); the node writes the whole file with the last. */
  writeFile(path: string, content: string | Uint8Array, options: CallOptions = {}): Promise<void> {
    const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    return this.writeFileFrom(path, (async function* () { yield bytes; })(), options);
  }

  /** Writes the file whole from `source`'s pieces, as `writeFile` writes it, sending each chunk as its
   * bytes arrive: holding at most a chunk and a piece, so a file of any size. Nothing is at `path` until
   * the last chunk (the node keeps the others aside). A failure of `source` is thrown. */
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

  /**
   * Starts processes in the directory (`process.run`: argv, no shell), for its `Git`. Each start waits for
   * the node as a call does, and is sent again only while it certainly did not run: a process is not safe
   * to repeat. It rejects (an `RpcFailure`) when the node does not accept it in time or refuses it (a
   * missing directory or program); a link that drops once it started fails `stdout` and `exited` alike.
   * `signal` stops a start waiting for the node, not the process once it started (cancelling its stdout
   * kills it).
   */
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

  /**
   * Runs `command` on the node, as Pi's local environment would there (`pi.exec`), under `options.call`'s
   * ID (one per command: the node refuses one it already has; a fresh one by default), feeding its output
   * updates to `options.onUpdate`, and returns how it exited. A dropped stream is picked up again from the
   * last record taken (`pi.execAttach`), on whichever link the node has then; output the node no longer
   * kept comes as a replacement of the whole view. With `attach`, `command` is not sent: the command
   * already sent under that ID is picked up from the start of its output, as after a dropped stream.
   * Aborting kills the command; a command the node does not know (it restarted, the server stayed away
   * past its grace period, or, attaching, it was never sent) fails `unknown` ("outcome unknown").
   */
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
    // The stream being read now: an abort whose kill cannot reach the node, or that kills nothing (the
    // client is detached), stops reading it.
    let reading: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const stopReading = () => { void reading?.cancel().catch(() => undefined); };
    const onAbort = () => {
      if (this.detached) stopReading();
      else void this.kill(execId).then(killed => { if (!killed) stopReading(); });
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      /** The output records taken so far: where to pick the output up again. */
      let taken = 0;
      let body: ReadableStream<Uint8Array> | undefined;
      if (!attach) {
        try {
          // Sent again only while it was certainly not run (waiting for the node); an unknown outcome is
          // picked up by attaching.
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

  /** Kills a command on the node (`pi.execKill`), retrying a short while; whether the node has it no
   * more (killed, or not known there). */
  private async kill(execId: string): Promise<boolean> {
    try {
      await this.onNode(node => node.request("pi.execKill", { execId }, { timeoutMs: NODE_CALL_TIMEOUT_MS }), { windowMs: NODE_CALL_TIMEOUT_MS, unknownWindowMs: NODE_CALL_TIMEOUT_MS });
      return true;
    } catch (error) {
      return refusal(error)?.code === "not_found";
    }
  }

  /** Kills the commands this client still runs, unless it was detached. Never throws. */
  async cleanup(): Promise<void> {
    if (this.detached) return;
    await Promise.allSettled([...this.running].map(execId => this.kill(execId)));
  }

  /**
   * Leaves this client's commands running on the node from now on: its runtime is being suspended (the
   * server is going away) and the next server process picks them up by their IDs (`exec` with `attach`).
   * An abort then only stops reading a command, and `cleanup` kills nothing. The node keeps a command for
   * its grace period from when the server's link drops.
   */
  detach(): void {
    this.detached = true;
  }
}

/**
 * Reads an exec's output records (NDJSON) from `reader`, giving each complete one to `take` with its
 * byte length, until its exit record (`exit`) or the stream stops (dropped, failed or ended early:
 * neither field), or a record is malformed (`malformed`).
 */
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

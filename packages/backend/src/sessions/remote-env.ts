/**
 * Pi's `ExecutionEnv` on a session's checkout on its node (ADR-029, ADR-030): the file operations and
 * commands of Pi's tools (read, write, edit, bash), and the discovery of the checkout's context files and
 * skills, run on the node (`fs.*`, `pi.exec`), which answers with what Pi's local environment returns there.
 *
 * It holds no link: each call asks `nodeFor` for the session's node, from the current app's hub (a link
 * drops when the app reloads, the server or the node restarts, or the network fails). A call that certainly
 * did not run (its node is not connected, no app is current, or it refuses it while it pauses to restart) waits for the node however long,
 * until the call is aborted or the node is removed. Short file operations are safe to repeat, so one whose
 * outcome is unknown after it was sent is sent again, within a bound. A command keeps running on the node
 * through a dropped link: the environment picks it up again by its ID from the last output it took
 * (`pi.execAttach`), feeding the same call, until the node no longer knows it (it restarted, or the
 * server stayed away past its grace period), which makes the call's outcome unknown. Aborting a call
 * kills its command (`pi.execKill`), unless the environment was detached (its runtime is suspended, the
 * server going away): then the command goes on, and the next server process picks it up by the ID its tool
 * call recorded (`execCommand` with `attach`).
 */
import { posix } from "node:path";
import {
  err, ExecutionError, FileError, ok, toError,
  type Context, type ExecutionEnv, type FileInfo, type Result, type ShellExecOptions, type ShellExecResult, type ShellOutputUpdate,
} from "@earendil-works/pi-agent-core";
import { APPLICATION_ERROR, WRITE_CHUNK_BYTES, execRecord, nodeError, RpcFailure, type ExecRecord, type FileErrorData } from "@reins/node-protocol";
import type { RemoteNode } from "../state.js";

/** How long a file operation whose outcome is unknown after it was sent (its link dropped, or its answer
 * did not come in time) is sent again, from the first such failure. */
export const ENV_RETRY_WINDOW_MS = 30_000;
/** How long a command whose stream dropped is looked for again: the node keeps it this long (its grace
 * period, `EXEC_GRACE_MS` on the node), so looking longer cannot find it. */
export const EXEC_REATTACH_WINDOW_MS = 60_000;
/** Bound on one file operation's answer (a read's bytes follow on its stream). */
const FS_CALL_TIMEOUT_MS = 60_000;
/** Bound on a node accepting a command or a request for its output, not on the command. */
const EXEC_CALL_TIMEOUT_MS = 10_000;
const RETRY_BACKOFF_MS = { initial: 50, max: 1_000 };
const backoff = (attempt: number) => Math.min(RETRY_BACKOFF_MS.max, RETRY_BACKOFF_MS.initial * 2 ** attempt);
/** Pi's bound on a command's timeout. */
const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1000;

export interface RemoteExecutionEnvOptions {
  /** The checkout's path on the node: relative paths resolve against it. */
  cwd: string;
  /** The session's node, from the current app's hub (`sessionNode`). It may wait until `signal` aborts; it
   * rejects with an `unavailable` failure when it cannot be reached now (no app: a reload's gap), and
   * otherwise when the node will never serve the session (it was removed). */
  nodeFor(signal?: AbortSignal): Promise<RemoteNode>;
  /** `ENV_RETRY_WINDOW_MS` by default. */
  retryWindowMs?: number;
  /** `EXEC_REATTACH_WINDOW_MS` by default. */
  reattachWindowMs?: number;
  /** A file operation the node did not answer (unreachable past its retries, a failure of the node or of
   * the link, an abort) throws, instead of answering Pi's file error: for discovering the checkout's
   * resources, which takes a file error as the file's own (missing or unreadable) and goes on without it. */
  strict?: boolean;
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

/** A file operation's answer on the wire. */
type FileAnswer<T> = { ok: true; value: T } | { ok: false; error: FileErrorData };

export class RemoteExecutionEnv implements ExecutionEnv {
  readonly cwd: string;
  private readonly nodeFor: RemoteExecutionEnvOptions["nodeFor"];
  private readonly retryWindowMs: number;
  private readonly reattachWindowMs: number;
  private readonly strict: boolean;
  /** Commands this environment started that have not ended. */
  private readonly running = new Set<string>();
  /** Set by `detach`: its commands outlive it. */
  private detached = false;

  constructor(options: RemoteExecutionEnvOptions) {
    this.cwd = options.cwd;
    this.nodeFor = options.nodeFor;
    this.retryWindowMs = options.retryWindowMs ?? ENV_RETRY_WINDOW_MS;
    this.reattachWindowMs = options.reattachWindowMs ?? EXEC_REATTACH_WINDOW_MS;
    this.strict = options.strict ?? false;
  }

  /**
   * Runs `call` on the session's node; again, after a short backoff, until `signal` aborts:
   * - while it certainly did not run (`notRun`: the node is not connected, or refuses it while it pauses
   *   to restart), however long, waiting for the node;
   * - while its outcome is unknown after it was sent, for `unknownWindowMs` from the first such failure
   *   (none: it is not sent again).
   * With `windowMs`, it is sent again for any of these only until `windowMs` has passed from the start
   * (what the node keeps only that long). Any other failure, a removed node's included, is thrown.
   */
  private async onNode<T>(call: (node: RemoteNode) => Promise<T>, { signal, unknownWindowMs, windowMs }: { signal?: AbortSignal; unknownWindowMs?: number; windowMs?: number }): Promise<T> {
    const deadline = windowMs === undefined ? Infinity : Date.now() + windowMs;
    let unknownDeadline: number | undefined;
    for (let attempt = 0; ; attempt++) {
      try { return await call(await this.nodeFor(signal)); }
      catch (error) {
        if (!unreachable(error) || signal?.aborted || Date.now() >= deadline) throw error;
        if (!notRun(error)) {
          if (unknownWindowMs === undefined) throw error;
          unknownDeadline ??= Date.now() + unknownWindowMs;
          if (Date.now() >= unknownDeadline) throw error;
        }
        await sleep(backoff(attempt), signal);
      }
    }
  }

  /** One file operation on the node (`call`, with the call's signal), and its answer as Pi's `Result`. One
   * the node did not answer is an `aborted` or `unknown` file error, or thrown when `strict`. */
  private async file<T>(context: Context, call: (node: RemoteNode, signal?: AbortSignal) => Promise<FileAnswer<T>>): Promise<Result<T, FileError>> {
    const signal = context.abortSignal;
    try {
      signal?.throwIfAborted();
      const answer = await this.onNode(node => call(node, signal), { signal, unknownWindowMs: this.retryWindowMs });
      return answer.ok ? ok(answer.value) : err(new FileError(answer.error.code, answer.error.message, answer.error.path));
    } catch (error) {
      if (this.strict) throw signal?.aborted ? signal.reason : error;
      if (signal?.aborted) return err(new FileError("aborted", "aborted"));
      return err(new FileError("unknown", messageOf(error), undefined, toError(error)));
    }
  }

  /** The call's params for `path`. */
  private at(path: string) { return { cwd: this.cwd, path }; }

  absolutePath(path: string, context: Context): Promise<Result<string, FileError>> {
    return this.file(context, (node, signal) => node.request("fs.absolutePath", this.at(path), { signal, timeoutMs: FS_CALL_TIMEOUT_MS }));
  }

  canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
    return this.file(context, (node, signal) => node.request("fs.canonicalPath", this.at(path), { signal, timeoutMs: FS_CALL_TIMEOUT_MS }));
  }

  fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
    return this.file(context, (node, signal) => node.request("fs.info", this.at(path), { signal, timeoutMs: FS_CALL_TIMEOUT_MS }));
  }

  /** `fileInfo`'s answer, as Pi's local environment reads it: a missing path does not exist. */
  async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
    const info = await this.fileInfo(path, context);
    if (info.ok) return ok(true);
    return info.error.code === "not_found" ? ok(false) : info;
  }

  listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
    return this.file(context, async (node, signal) => {
      const answer = await node.request("fs.list", this.at(path), { signal, timeoutMs: FS_CALL_TIMEOUT_MS });
      return answer.ok ? { ok: true, value: answer.value.entries.map(entry => ({ ...entry, path: posix.join(answer.value.path, entry.name) })) } : answer;
    });
  }

  /** The file's bytes, from its stream; a read whose bytes did not all arrive is read again. */
  readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
    return this.file(context, async (node, signal) => {
      const opened = await node.openStream("fs.read", this.at(path), { signal, timeoutMs: FS_CALL_TIMEOUT_MS });
      const bytes = await bytesOf(opened.body);
      const { result } = opened;
      if (!result.ok) return result;
      if (result.value.size !== bytes.byteLength) throw new RpcFailure("unavailable", `Read ${bytes.byteLength} of ${result.value.size} bytes`, "unknown");
      return { ok: true, value: bytes };
    });
  }

  /** The file's bytes as UTF-8, decoded as Pi's local environment decodes them (a byte-order mark is kept). */
  async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
    const bytes = await this.readBinaryFile(path, context);
    return bytes.ok ? ok(Buffer.from(bytes.value.buffer, bytes.value.byteOffset, bytes.value.byteLength).toString("utf8")) : bytes;
  }

  /** Sent in chunks (`WRITE_CHUNK_BYTES`); the node writes the whole file with the last. */
  async writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content.buffer, content.byteOffset, content.byteLength);
    const writeId = crypto.randomUUID();
    for (let offset = 0; ; offset += WRITE_CHUNK_BYTES) {
      const last = offset + WRITE_CHUNK_BYTES >= bytes.byteLength;
      const data = bytes.subarray(offset, offset + WRITE_CHUNK_BYTES).toString("base64");
      const result = await this.file(context, (node, signal) => node.request("fs.write", { ...this.at(path), writeId, offset, data, last }, { signal, timeoutMs: FS_CALL_TIMEOUT_MS }));
      if (!result.ok) return result;
      if (last) return ok(undefined);
    }
  }

  async joinPath(parts: string[], _context?: Context): Promise<Result<string, FileError>> {
    return ok(posix.join(...parts));
  }

  // Not used by Pi's tools or its skill discovery, so not served by nodes.
  readTextLines(path: string): Promise<Result<string[], FileError>> { return unsupported("readTextLines", path); }
  appendFile(path: string): Promise<Result<void, FileError>> { return unsupported("appendFile", path); }
  renameFile(path: string): Promise<Result<void, FileError>> { return unsupported("renameFile", path); }
  createDir(path: string): Promise<Result<void, FileError>> { return unsupported("createDir", path); }
  remove(path: string): Promise<Result<void, FileError>> { return unsupported("remove", path); }
  createTempDir(): Promise<Result<string, FileError>> { return unsupported("createTempDir"); }
  createTempFile(): Promise<Result<string, FileError>> { return unsupported("createTempFile"); }

  /**
   * Runs `command` on the node, as Pi's local environment would there (`pi.exec`), feeding its output
   * updates to `options.onUpdate`. A dropped stream is picked up again from the last record taken
   * (`pi.execAttach`), on whichever link the node has then; output the node no longer kept comes as a
   * replacement of the whole view. Aborting kills the command and returns `aborted`, as locally; a
   * command the node no longer knows comes back `unknown` ("outcome unknown").
   */
  exec(command: string, options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
    return this.execCommand({ execId: crypto.randomUUID(), attach: false }, command, options, context);
  }

  /**
   * `exec` under the ID `call` names (one per command: the node refuses one it already has). With
   * `attach`, `command` is not sent: the command already sent under that ID is picked up from the start of
   * its output (`pi.execAttach`), as after a dropped stream; one the node does not know (it restarted,
   * the server stayed away past its grace period, or it was never sent) comes back `unknown`.
   */
  async execCommand(call: CommandCall, command: string, options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
    const signal = context.abortSignal;
    if (signal?.aborted) return err(new ExecutionError("aborted", "aborted"));
    const timeout = options?.timeout;
    if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) return err(new ExecutionError("timeout", "Invalid timeout: must be a finite number of seconds"));
    if (timeout !== undefined && timeout > MAX_TIMEOUT_SECONDS) return err(new ExecutionError("timeout", `Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`));
    this.running.add(call.execId);
    try { return await this.runExec(call, command, options, context); }
    finally { this.running.delete(call.execId); }
  }

  private async runExec({ execId, attach }: CommandCall, command: string, options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
    const signal = context.abortSignal;
    const { onUpdate, ...rest } = options ?? {};
    let callbackError: ExecutionError | undefined;
    const update = (value: ShellOutputUpdate) => {
      if (callbackError || !onUpdate) return;
      try { onUpdate(value, context); }
      catch (error) {
        callbackError = new ExecutionError("callback_error", messageOf(error), toError(error));
        void this.kill(execId);
      }
    };
    // The stream being read now: an abort whose kill cannot reach the node, or that kills nothing (the
    // environment is detached), stops reading it.
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
          body = (await this.onNode(node => node.openStream("pi.exec", { cwd: this.cwd, execId, command, options: rest }, { signal, timeoutMs: EXEC_CALL_TIMEOUT_MS }),
            { signal })).body;
        } catch (error) {
          if (signal?.aborted) return err(new ExecutionError("aborted", "aborted"));
          if (!(error instanceof RpcFailure && error.outcome === "unknown")) return err(new ExecutionError("spawn_error", messageOf(error), toError(error)));
        }
      }
      for (;;) {
        if (body) {
          if (signal?.aborted) { void body.cancel().catch(() => undefined); return err(new ExecutionError("aborted", "aborted")); }
          reading = body.getReader();
          const read = await readRecords(reading, record => {
            taken += record.bytes;
            if ("update" in record.value) update(record.value.update);
          });
          if (read.exit) {
            if (callbackError) return err(callbackError);
            const { exit } = read;
            if (!exit.ok && exit.error.code === "timeout") return err(new ExecutionError("timeout", exit.error.message));
            if (signal?.aborted) return err(new ExecutionError("aborted", "aborted"));
            return exit.ok ? ok(exit.value) : err(new ExecutionError(exit.error.code, exit.error.message));
          }
          if (read.malformed) { void this.kill(execId); return err(new ExecutionError("unknown", `${OUTCOME_UNKNOWN}: ${read.malformed}`)); }
        }
        if (signal?.aborted) return err(new ExecutionError("aborted", "aborted"));
        if (callbackError) return err(callbackError);
        try {
          const attached = await this.onNode(node => node.openStream("pi.execAttach", { execId, offset: taken }, { signal, timeoutMs: EXEC_CALL_TIMEOUT_MS }),
            { signal, windowMs: this.reattachWindowMs, unknownWindowMs: this.reattachWindowMs });
          if (attached.result.view) update({ kind: "replace", output: attached.result.view });
          taken = attached.result.offset;
          body = attached.body;
        } catch (error) {
          if (signal?.aborted) return err(new ExecutionError("aborted", "aborted"));
          const why = refusal(error)?.code === "not_found"
            ? `the node does not have it (it restarted, or the server stayed away past its grace period${attach ? ", or it was never sent" : ""})`
            : messageOf(error);
          return err(new ExecutionError("unknown", `${OUTCOME_UNKNOWN}: ${why}`, toError(error)));
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
      await this.onNode(node => node.request("pi.execKill", { execId }, { timeoutMs: EXEC_CALL_TIMEOUT_MS }), { windowMs: EXEC_CALL_TIMEOUT_MS, unknownWindowMs: EXEC_CALL_TIMEOUT_MS });
      return true;
    } catch (error) {
      return refusal(error)?.code === "not_found";
    }
  }

  /** Kills the commands this environment still runs, unless it was detached. Never throws. */
  async cleanup(_context?: Context): Promise<void> {
    if (this.detached) return;
    await Promise.allSettled([...this.running].map(execId => this.kill(execId)));
  }

  /**
   * Leaves this environment's commands running on the node from now on: its runtime is being suspended
   * (the server is going away) and the next server process picks them up by their IDs (`execCommand` with
   * `attach`). An abort then only stops reading a command, and `cleanup` kills nothing. The node keeps a
   * command for its grace period from when the server's link drops.
   */
  detach(): void {
    this.detached = true;
  }
}

function unsupported<T>(op: string, path?: string): Promise<Result<T, FileError>> {
  return Promise.resolve(err(new FileError("not_supported", `${op} is not supported on a node`, path)));
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

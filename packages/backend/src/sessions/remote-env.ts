/**
 * Pi's `ExecutionEnv` on a session's checkout on its node (ADR-029): the file operations and commands of
 * Pi's tools (read, write, edit, bash) run on the node (`env.fs`, `env.exec`), which answers with what
 * Pi's local environment returns there.
 *
 * It holds no hub: each call asks `nodeFor` for the session's node, from whichever handler load serves
 * now (a runtime outlives a load, and every reload drops every link). Short file operations are safe to
 * repeat, so one whose node is not reachable or whose outcome is unknown is sent again, within a bound.
 * A command keeps running on the node through a dropped link: the environment picks it up again by its ID
 * from the last output it took (`env.execAttach`), feeding the same call, until the node no longer knows
 * it (it restarted, or the server stayed away past its grace period), which makes the call's outcome
 * unknown. Aborting a call kills its command (`env.execKill`).
 */
import { posix } from "node:path";
import {
  err, ExecutionError, FileError, ok, toError,
  type Context, type ExecutionEnv, type FileInfo, type Result, type ShellExecOptions, type ShellExecResult, type ShellOutputUpdate,
} from "@earendil-works/pi-agent-core";
import { APPLICATION_ERROR, ATTACHMENT_CHUNK_BYTES, execRecord, nodeError, RpcFailure, type EnvFs, type EnvFsResult, type ExecRecord } from "@reins/node-protocol";
import type { RemoteNode } from "../state.js";

/** How long a file operation is sent again while its node is unreachable. */
export const ENV_RETRY_WINDOW_MS = 30_000;
/** How long a command whose stream dropped is looked for again: the node keeps it this long (its grace
 * period, `EXEC_GRACE_MS` on the node), so looking longer cannot find it. */
export const EXEC_REATTACH_WINDOW_MS = 60_000;
/** Bound on one file operation's answer (a read's bytes follow on its stream). */
const FS_CALL_TIMEOUT_MS = 60_000;
/** Bound on a node accepting a command or a request for its output, not on the command. */
const EXEC_CALL_TIMEOUT_MS = 10_000;
const RETRY_BACKOFF_MS = { initial: 50, max: 1_000 };
/** Pi's bound on a command's timeout. */
const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1000;

export interface RemoteExecutionEnvOptions {
  sourceId: number;
  /** The checkout's path on the node: relative paths resolve against it. */
  cwd: string;
  /** The session's node, from the handler load serving now. It may wait (for the node's link, or a load
   * during a reload) until `signal` aborts; it rejects when the node will never serve the session. */
  nodeFor(signal?: AbortSignal): Promise<RemoteNode>;
  /** `ENV_RETRY_WINDOW_MS` by default. */
  retryWindowMs?: number;
  /** `EXEC_REATTACH_WINDOW_MS` by default. */
  reattachWindowMs?: number;
}

/** Whether a failed call may be sent again: the node was not reachable, or the outcome is unknown. */
const unreachable = (error: unknown) => error instanceof RpcFailure && error.code === "unavailable";
/** The node's definite refusal of a call, if it was one. */
const refusal = (error: unknown) => error instanceof RpcFailure && error.code === APPLICATION_ERROR ? nodeError.safeParse(error.data).data : undefined;
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

type FsOp = EnvFs["op"];
type FsArgs<Op extends FsOp> = Extract<EnvFs, { op: Op }>["args"];
type FsValue = Extract<EnvFsResult, { ok: true }>["value"];

export class RemoteExecutionEnv implements ExecutionEnv {
  readonly cwd: string;
  private readonly sourceId: number;
  private readonly nodeFor: RemoteExecutionEnvOptions["nodeFor"];
  private readonly retryWindowMs: number;
  private readonly reattachWindowMs: number;
  /** Commands this environment started that have not ended. */
  private readonly running = new Set<string>();

  constructor(options: RemoteExecutionEnvOptions) {
    this.cwd = options.cwd;
    this.sourceId = options.sourceId;
    this.nodeFor = options.nodeFor;
    this.retryWindowMs = options.retryWindowMs ?? ENV_RETRY_WINDOW_MS;
    this.reattachWindowMs = options.reattachWindowMs ?? EXEC_REATTACH_WINDOW_MS;
  }

  /** Runs `call` on the session's node; again, after a short backoff, while it fails because the node is
   * unreachable or its outcome is unknown and `retry` allows, until `windowMs` has passed or `signal`
   * aborts. */
  private async onNode<T>(call: (node: RemoteNode) => Promise<T>, { signal, windowMs = this.retryWindowMs, retry = unreachable }: { signal?: AbortSignal; windowMs?: number; retry?: (error: unknown) => boolean } = {}): Promise<T> {
    const deadline = Date.now() + windowMs;
    for (let attempt = 0; ; attempt++) {
      try { return await call(await this.nodeFor(signal)); }
      catch (error) {
        if (!retry(error) || signal?.aborted || Date.now() >= deadline) throw error;
        await sleep(Math.min(RETRY_BACKOFF_MS.max, RETRY_BACKOFF_MS.initial * 2 ** attempt), signal);
      }
    }
  }

  /** One file operation on the node, with the bytes of its stream (a read's). */
  private async fs<Op extends FsOp>(op: Op, args: FsArgs<Op>, context: Context): Promise<Result<{ value: FsValue; bytes: Uint8Array }, FileError>> {
    const signal = context.abortSignal;
    const aborted = () => err<{ value: FsValue; bytes: Uint8Array }, FileError>(new FileError("aborted", "aborted"));
    if (signal?.aborted) return aborted();
    try {
      const { result, bytes } = await this.onNode(async node => {
        const opened = await node.openStream("env.fs", { sourceId: this.sourceId, cwd: this.cwd, op, args }, { signal, timeoutMs: FS_CALL_TIMEOUT_MS });
        const received = await bytesOf(opened.body);
        // A read whose bytes did not all arrive is read again.
        const { result: answer } = opened;
        const size = answer.ok && (op === "readTextFile" || op === "readBinaryFile") && answer.value !== null && typeof answer.value === "object" ? answer.value.size : received.byteLength;
        if (size !== received.byteLength) throw new RpcFailure("unavailable", `Read ${received.byteLength} of ${size} bytes`, "unknown");
        return { result: answer, bytes: received };
      }, { signal });
      if (!result.ok) return err(new FileError(result.error.code, result.error.message, result.error.path));
      return ok({ value: result.value, bytes });
    } catch (error) {
      if (signal?.aborted) return aborted();
      return err(new FileError("unknown", messageOf(error), undefined, toError(error)));
    }
  }

  /** A file operation's value, as `expected` reads it (anything else is the node's error). */
  private async value<T>(op: FsOp, path: string, context: Context, expected: (value: FsValue, bytes: Uint8Array) => T | undefined): Promise<Result<T, FileError>> {
    const result = await this.fs(op, { path }, context);
    if (!result.ok) return result;
    const value = expected(result.value.value, result.value.bytes);
    return value === undefined ? err(new FileError("unknown", `Unexpected answer to ${op}`, path)) : ok(value);
  }

  absolutePath(path: string, context: Context): Promise<Result<string, FileError>> {
    return this.value("absolutePath", path, context, value => typeof value === "string" ? value : undefined);
  }

  canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
    return this.value("canonicalPath", path, context, value => typeof value === "string" ? value : undefined);
  }

  exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
    return this.value("exists", path, context, value => typeof value === "boolean" ? value : undefined);
  }

  fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
    return this.value("fileInfo", path, context, value => value !== null && typeof value === "object" && "kind" in value ? value : undefined);
  }

  readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
    return this.value("readBinaryFile", path, context, (_value, bytes) => bytes);
  }

  /** The file's bytes as UTF-8, decoded as Pi's local environment decodes them (a byte-order mark is kept). */
  readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
    return this.value("readTextFile", path, context, (_value, bytes) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8"));
  }

  /** Sent in chunks (`ATTACHMENT_CHUNK_BYTES`); the node writes the whole file with the last. */
  async writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content.buffer, content.byteOffset, content.byteLength);
    const writeId = crypto.randomUUID();
    for (let offset = 0; ; offset += ATTACHMENT_CHUNK_BYTES) {
      const last = offset + ATTACHMENT_CHUNK_BYTES >= bytes.byteLength;
      const data = bytes.subarray(offset, offset + ATTACHMENT_CHUNK_BYTES).toString("base64");
      const result = await this.fs("writeFile", { path, writeId, offset, data, last }, context);
      if (!result.ok) return result;
      if (last) return ok(undefined);
    }
  }

  async joinPath(parts: string[], _context?: Context): Promise<Result<string, FileError>> {
    return ok(posix.join(...parts));
  }

  // Not used by Pi's tools, so not served by nodes.
  readTextLines(path: string): Promise<Result<string[], FileError>> { return unsupported("readTextLines", path); }
  appendFile(path: string): Promise<Result<void, FileError>> { return unsupported("appendFile", path); }
  renameFile(path: string): Promise<Result<void, FileError>> { return unsupported("renameFile", path); }
  listDir(path: string): Promise<Result<FileInfo[], FileError>> { return unsupported("listDir", path); }
  createDir(path: string): Promise<Result<void, FileError>> { return unsupported("createDir", path); }
  remove(path: string): Promise<Result<void, FileError>> { return unsupported("remove", path); }
  createTempDir(): Promise<Result<string, FileError>> { return unsupported("createTempDir"); }
  createTempFile(): Promise<Result<string, FileError>> { return unsupported("createTempFile"); }

  /**
   * Runs `command` on the node, as Pi's local environment would there (`env.exec`), feeding its output
   * updates to `options.onUpdate`. A dropped stream is picked up again from the last record taken
   * (`env.execAttach`), on whichever link the node has then; output the node no longer kept comes as a
   * replacement of the whole view. Aborting kills the command and returns `aborted`, as locally; a
   * command the node no longer knows comes back `unknown` ("outcome unknown").
   */
  async exec(command: string, options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
    const signal = context.abortSignal;
    if (signal?.aborted) return err(new ExecutionError("aborted", "aborted"));
    const timeout = options?.timeout;
    if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) return err(new ExecutionError("timeout", "Invalid timeout: must be a finite number of seconds"));
    if (timeout !== undefined && timeout > MAX_TIMEOUT_SECONDS) return err(new ExecutionError("timeout", `Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`));
    const execId = crypto.randomUUID();
    this.running.add(execId);
    try { return await this.runExec(execId, command, options, context); }
    finally { this.running.delete(execId); }
  }

  private async runExec(execId: string, command: string, options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
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
    // The stream being read now: an abort whose kill cannot reach the node stops reading it.
    let reading: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const onAbort = () => { void this.kill(execId).then(killed => { if (!killed) void reading?.cancel().catch(() => undefined); }); };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      /** The output records taken so far: where to pick the output up again. */
      let taken = 0;
      let body: ReadableStream<Uint8Array> | undefined;
      try {
        // Sent again only while it was certainly not sent; an unknown outcome is picked up by attaching.
        body = (await this.onNode(node => node.openStream("env.exec", { sourceId: this.sourceId, cwd: this.cwd, execId, command, options: rest }, { signal, timeoutMs: EXEC_CALL_TIMEOUT_MS }),
          { signal, retry: error => unreachable(error) && error instanceof RpcFailure && error.outcome === undefined })).body;
      } catch (error) {
        if (signal?.aborted) return err(new ExecutionError("aborted", "aborted"));
        if (!(error instanceof RpcFailure && error.outcome === "unknown")) return err(new ExecutionError("spawn_error", messageOf(error), toError(error)));
      }
      for (;;) {
        if (body) {
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
          const attached = await this.onNode(node => node.openStream("env.execAttach", { execId, offset: taken }, { signal, timeoutMs: EXEC_CALL_TIMEOUT_MS }), { signal, windowMs: this.reattachWindowMs });
          if (attached.result.view) update({ kind: "replace", output: attached.result.view });
          taken = attached.result.offset;
          body = attached.body;
        } catch (error) {
          if (signal?.aborted) return err(new ExecutionError("aborted", "aborted"));
          const why = refusal(error)?.code === "not_found" ? "the node no longer has it (it restarted, or the server stayed away past its grace period)" : messageOf(error);
          return err(new ExecutionError("unknown", `${OUTCOME_UNKNOWN}: ${why}`, toError(error)));
        }
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Kills a command on the node (`env.execKill`), retrying a short while; whether the node has it no
   * more (killed, or not known there). */
  private async kill(execId: string): Promise<boolean> {
    try {
      await this.onNode(node => node.request("env.execKill", { execId }, { timeoutMs: EXEC_CALL_TIMEOUT_MS }), { windowMs: EXEC_CALL_TIMEOUT_MS });
      return true;
    } catch (error) {
      return refusal(error)?.code === "not_found";
    }
  }

  /** Kills the commands this environment still runs. Never throws. */
  async cleanup(_context?: Context): Promise<void> {
    await Promise.allSettled([...this.running].map(execId => this.kill(execId)));
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

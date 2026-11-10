/**
 * A long-running process on a node, as the server sees it (`process.*`, node-contract.md *Processes*): what
 * an MCP client needs of a stdio server. Its stdout is read as whole lines or as raw chunks, its stdin
 * written in order with backpressure, its stderr kept as a tail. It belongs to the node link that started
 * it: when that link drops the node stops it, and `exited` says so. Nothing reattaches it.
 *
 * Every buffer is bounded: stdout by the stream's buffer on the server (`MAX_STREAM_BUFFER_BYTES`; a
 * process whose stdout nobody reads fails at it) and a line's length (`maxLineBytes`), stdin by
 * `MAX_PENDING_INPUT_BYTES` not yet taken by the process, stderr by the tail the node keeps.
 */

import { APPLICATION_ERROR, MAX_PROCESS_STDERR_CHARS, RpcFailure, WRITE_CHUNK_BYTES, nodeError, type ProcessExit } from "@reins/node-protocol";
import type { NodeClient } from "../state.js";
import { logger } from "../logger.js";
import { MAX_STREAM_BUFFER_BYTES } from "./node-streams.js";

/** Bounds the node's answer to starting a process. */
const START_TIMEOUT_MS = 10_000;
/** A write is answered once the process has taken its bytes: one that reads nothing for this long fails it. */
export const PROCESS_WRITE_TIMEOUT_MS = 60_000;
/** Input written and not yet taken by the process. */
export const MAX_PENDING_INPUT_BYTES = 16 * 1024 * 1024;
/** The longest stdout line by default; at most the stream's buffer. */
export const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024;
export const MAX_LINE_BYTES = MAX_STREAM_BUFFER_BYTES;

/** How a process ended: its exit code or signal, and `error` when it ended for another reason than its
 * own (its link dropped, a line was too long, its stdout was not read). */
export interface NodeProcessExit { code: number | null; signal: string | null; error?: string }

export interface NodeProcessSpec {
  /** An absolute path on the node. */
  cwd: string;
  /** No shell, or a `/bin/sh -c` command: exactly one. */
  argv?: string[];
  command?: string;
  /** Added to the node's environment; sent to the node at the start only. */
  env?: Record<string, string>;
  maxLineBytes?: number;
  /** Stops the process. */
  signal?: AbortSignal;
}

const refusal = (error: unknown) => error instanceof RpcFailure && error.code === APPLICATION_ERROR ? nodeError.safeParse(error.data).data : undefined;
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

export class NodeProcess {
  readonly exited: Promise<NodeProcessExit>;
  private stdoutTaken = false;
  private failure: string | undefined;
  private ended = false;
  private stderr = "";
  private readonly stderrListeners = new Set<(text: string) => void>();
  private input: Promise<void> = Promise.resolve();
  private pendingInput = 0;
  private inputClosed = false;

  private constructor(
    private readonly node: NodeClient,
    readonly id: string,
    readonly pid: number,
    private readonly stdout: ReadableStream<Uint8Array>,
    stdoutEnded: Promise<ProcessExit | undefined>,
    private readonly maxLineBytes: number,
  ) {
    this.exited = stdoutEnded.then(
      exit => {
        if (exit) this.stderr = exit.stderr;
        return { code: exit?.code ?? null, signal: exit?.signal ?? null, ...(this.failure ? { error: this.failure } : {}) };
      },
      (error: unknown) => ({ code: null, signal: null, error: this.failure ?? endedBy(error) }),
    ).finally(() => { this.ended = true; });
  }

  get nodeId(): string { return this.node.id; }

  /** Resolves once the process runs; rejects with the node's refusal (a missing `cwd`, a program not on
   * `PATH`, the node's process limit) or when the node is not reached. */
  static async start(node: NodeClient, { cwd, argv, command, env, maxLineBytes = DEFAULT_MAX_LINE_BYTES, signal }: NodeProcessSpec): Promise<NodeProcess> {
    signal?.throwIfAborted();
    const id = crypto.randomUUID();
    const { result, body, ended } = await node.openStream("process.start", {
      cwd, processId: id, ...(argv ? { argv } : { command: command ?? "" }), ...(env ? { env } : {}),
    }, { timeoutMs: START_TIMEOUT_MS });
    const started = new NodeProcess(node, id, result.pid, body, ended, maxLineBytes);
    started.readStderr();
    if (signal) {
      const stop = () => void started.stop();
      if (signal.aborted) stop();
      else {
        signal.addEventListener("abort", stop, { once: true });
        void started.exited.then(() => signal.removeEventListener("abort", stop));
      }
    }
    return started;
  }

  /** Stdout as whole lines, without their `\n` (or `\r\n`); a last line without one is given at the end. A
   * line longer than `maxLineBytes` stops the process and throws. Read either this or `chunks`, once. */
  get lines(): AsyncIterable<string> {
    return { [Symbol.asyncIterator]: () => this.readLines() };
  }

  /** Stdout as the node read it. Read either this or `lines`, once. */
  get chunks(): AsyncIterable<Uint8Array> {
    return { [Symbol.asyncIterator]: () => this.readChunks() };
  }

  /** Resolves once the process has taken the bytes (in order with earlier writes). */
  write(data: string | Uint8Array): Promise<void> {
    const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    if (this.ended) return Promise.reject(new Error("The process has exited"));
    if (this.inputClosed) return Promise.reject(new Error("The process's input is closed"));
    if (this.pendingInput + bytes.byteLength > MAX_PENDING_INPUT_BYTES) {
      return Promise.reject(new Error(`The process has not taken ${this.pendingInput} bytes of its input yet, and may hold at most ${MAX_PENDING_INPUT_BYTES}: it is not reading its input`));
    }
    this.pendingInput += bytes.byteLength;
    return this.queue(async () => {
      try {
        for (let start = 0; start < bytes.byteLength; start += WRITE_CHUNK_BYTES) {
          await this.send({ data: bytes.subarray(start, start + WRITE_CHUNK_BYTES).toString("base64") });
        }
      } finally { this.pendingInput -= bytes.byteLength; }
    });
  }

  /** Closes stdin once earlier writes are taken. */
  closeInput(): Promise<void> {
    if (this.inputClosed || this.ended) return Promise.resolve();
    this.inputClosed = true;
    return this.queue(() => this.send({ end: true }));
  }

  /** The last `MAX_PROCESS_STDERR_CHARS` of its stderr. */
  stderrTail(): string { return this.stderr; }

  /** Hears its stderr as it comes, from when it is added. */
  onStderr(listener: (text: string) => void): () => void {
    this.stderrListeners.add(listener);
    return () => { this.stderrListeners.delete(listener); };
  }

  /** Stdin closed, then SIGTERM to its process group, then SIGKILL after the node's grace period; resolves
   * once it has ended. */
  async stop(): Promise<NodeProcessExit> {
    if (!this.ended) {
      // Unknown (it ended) or unreachable (its link dropped, which stops it too): `exited` says how it ended.
      await this.node.request("process.stop", { processId: this.id }, { timeoutMs: START_TIMEOUT_MS }).catch(() => undefined);
    }
    return this.exited;
  }

  private queue(work: () => Promise<void>): Promise<void> {
    const done = this.input.then(work);
    this.input = done.catch(() => undefined);
    return done;
  }

  private async send(input: { data?: string; end?: boolean }): Promise<void> {
    try {
      await this.node.request("process.write", { processId: this.id, ...input }, { timeoutMs: PROCESS_WRITE_TIMEOUT_MS });
    } catch (error) {
      const refused = refusal(error);
      if (refused?.code === "not_found") throw new Error("The process has exited", { cause: error });
      throw new Error(refused?.message ?? messageOf(error), { cause: error });
    }
  }

  private takeStdout(): ReadableStreamDefaultReader<Uint8Array> {
    if (this.stdoutTaken) throw new Error("A process's stdout is read once: as lines or as chunks");
    this.stdoutTaken = true;
    return this.stdout.getReader();
  }

  private async *readChunks(): AsyncGenerator<Uint8Array> {
    const reader = this.takeStdout();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  }

  private async *readLines(): AsyncGenerator<string> {
    const reader = this.takeStdout();
    const decoder = new TextDecoder();
    const text = (parts: Uint8Array[]) => decoder.decode(Buffer.concat(parts)).replace(/\r$/, "");
    let partial: Uint8Array[] = [];
    let partialBytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      let start = 0;
      for (let newline = value.indexOf(10); newline !== -1; newline = value.indexOf(10, start)) {
        if (partialBytes + newline - start > this.maxLineBytes) this.lineTooLong(reader);
        partial.push(value.subarray(start, newline));
        yield text(partial);
        partial = [];
        partialBytes = 0;
        start = newline + 1;
      }
      if (start < value.byteLength) {
        partial.push(value.subarray(start));
        partialBytes += value.byteLength - start;
        if (partialBytes > this.maxLineBytes) this.lineTooLong(reader);
      }
    }
    if (partialBytes > 0) yield text(partial);
  }

  /** The process is stopped, and what is left of its stdout drained, so its exit still arrives. */
  private lineTooLong(reader: ReadableStreamDefaultReader<Uint8Array>): never {
    this.failure = `A line of its stdout was longer than ${this.maxLineBytes} bytes`;
    void this.stop();
    void (async () => { while (!(await reader.read()).done); })().catch(() => undefined);
    throw new Error(this.failure);
  }

  /** In the background: the node gives the tail it kept first, so nothing since the start is missed. */
  private readStderr(): void {
    void (async () => {
      const { body } = await this.node.openStream("process.stderr", { processId: this.id }, { timeoutMs: START_TIMEOUT_MS });
      const decoder = new TextDecoder();
      for await (const chunk of body) {
        const text = decoder.decode(chunk, { stream: true });
        if (this.ended) continue;
        this.stderr = (this.stderr + text).slice(-MAX_PROCESS_STDERR_CHARS);
        for (const listener of this.stderrListeners) {
          try { listener(text); } catch (error) { logger.warn(`A process's stderr listener threw: ${messageOf(error)}`); }
        }
      }
    })().catch(() => undefined);
  }
}

function endedBy(error: unknown): string {
  if (error instanceof RpcFailure && error.code === "unavailable") return "The node's link dropped, which stopped the process";
  return messageOf(error);
}

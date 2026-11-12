/**
 * A long-running process on a node, as the server sees it (`process.*`, node-contract.md *Processes*): what
 * an MCP client needs of a stdio server. Its stdout is read as whole lines or as raw chunks, its stdin
 * written in order with backpressure, its stderr kept as a tail.
 *
 * A process outlives the link that started it: when its output stream drops, the server attaches again on the
 * node's next link from the offset it had read to (`process.attach`), within the node's grace period, and
 * resends a write whose answer was lost at its input offset (the node skips what it already took). So
 * `exited` resolves only for a real end: its exit, a stop, or the node no longer having it.
 *
 * Every buffer is bounded: stdout by `MAX_STREAM_BUFFER_BYTES` (a process whose stdout nobody reads fails at
 * it) and a line's length (`maxLineBytes`), stdin by `MAX_PENDING_INPUT_BYTES` not yet taken by the process,
 * stderr by the tail kept.
 */

import { APPLICATION_ERROR, OUTPUT_FRAME_HEADER_BYTES, RpcFailure, WRITE_CHUNK_BYTES, nodeError, outputParser } from "@reins/node-protocol";
import type { NodeClient } from "../state.js";
import { logger } from "../logger.js";
import { MAX_STREAM_BUFFER_BYTES, type NodeStream } from "./node-streams.js";
import { stderrTail } from "./process-output.js";

/** Bounds the node's answer to starting or attaching to a process. */
const START_TIMEOUT_MS = 10_000;
/** A write is answered once the process has taken its bytes: one that reads nothing for this long fails it. */
export const PROCESS_WRITE_TIMEOUT_MS = 60_000;
/** The node's grace period (`PROCESS_GRACE_MS`): a process with no stream is kept this long, so looking longer
 * cannot find it. */
export const PROCESS_REATTACH_WINDOW_MS = 60_000;
/** Input written and not yet taken by the process. */
export const MAX_PENDING_INPUT_BYTES = 16 * 1024 * 1024;
/** The longest stdout line by default; at most the stream's buffer. */
export const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024;
export const MAX_LINE_BYTES = MAX_STREAM_BUFFER_BYTES;
const RETRY_BACKOFF_MS = { initial: 50, max: 1_000 };
const backoff = (attempt: number) => Math.min(RETRY_BACKOFF_MS.max, RETRY_BACKOFF_MS.initial * 2 ** attempt);

/** How a process ended: its exit code or signal, and `error` when it ended for another reason than its
 * own (a line was too long, its stdout was not read, its node no longer has it). `detached`: it did not end,
 * it was let go (its extension unloading) and it runs on, for the next app to attach to. */
export interface NodeProcessExit { code: number | null; signal: string | null; error?: string; detached?: true }

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

/** What a handle says of how it came to be (the host's, for a keyed process). */
export interface HandleOptions {
  maxLineBytes?: number;
  /** Stops the process. */
  signal?: AbortSignal;
  key?: string | null;
  reattached?: boolean;
  /** How the process last kept under its key ended, when the host found it gone. */
  previous?: NodeProcessExit;
}

/** The node no longer has it: it restarted, or kept it past its grace period. */
export const LOST_ERROR = "The process is gone: its node restarted, or kept it past its grace period with no server attached";

const refusal = (error: unknown) => error instanceof RpcFailure && error.code === APPLICATION_ERROR ? nodeError.safeParse(error.data).data : undefined;
/** Not reached: no link, a link dropped, or no answer in time. */
const unreachable = (error: unknown) => error instanceof RpcFailure && error.code === "unavailable";
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

export class NodeProcess {
  readonly exited: Promise<NodeProcessExit>;
  readonly key: string | null;
  readonly reattached: boolean;
  readonly previous: NodeProcessExit | undefined;
  /** Where its output has been read to: a frame boundary, where an attach resumes. */
  offset: number;
  /** Bytes of its output never read here: its node kept only a tail while no server read it. */
  lostBytes = 0;
  private ended = false;
  private settle!: (exit: NodeProcessExit) => void;
  private failure: string | undefined;
  private detached = false;
  private readonly wake = new AbortController();
  /** The stream read now: detaching cancels it, which starts the node's grace period. */
  private reading: ReadableStreamDefaultReader<Uint8Array> | undefined;
  private readonly stderr = stderrTail();
  private readonly stderrListeners = new Set<(text: string) => void>();
  private stdoutTaken = false;
  private stdoutCancelled = false;
  private readonly stdout: ReadableStream<Uint8Array>;
  private stdoutController!: ReadableStreamDefaultController<Uint8Array>;
  private readonly maxLineBytes: number;
  private input: Promise<void> = Promise.resolve();
  /** Where the next write goes in its stdin. */
  private inputOffset: number;
  private pendingInput = 0;
  private inputClosed = false;

  private constructor(
    private readonly node: NodeClient,
    readonly id: string,
    readonly pid: number,
    { offset, input }: { offset: number; input: number },
    { maxLineBytes = DEFAULT_MAX_LINE_BYTES, signal, key = null, reattached = false, previous }: HandleOptions,
  ) {
    this.offset = offset;
    this.inputOffset = input;
    this.maxLineBytes = maxLineBytes;
    this.key = key;
    this.reattached = reattached;
    this.previous = previous;
    this.exited = new Promise(resolve => { this.settle = resolve; });
    this.stdout = new ReadableStream<Uint8Array>({
      start: controller => { this.stdoutController = controller; },
      cancel: () => { this.stdoutCancelled = true; },
    }, { highWaterMark: MAX_STREAM_BUFFER_BYTES, size: chunk => chunk?.byteLength ?? 0 });
    if (signal) {
      const stop = () => void this.stop();
      if (signal.aborted) stop();
      else {
        signal.addEventListener("abort", stop, { once: true });
        void this.exited.then(() => signal.removeEventListener("abort", stop));
      }
    }
  }

  get nodeId(): string { return this.node.id; }

  /** Resolves once the process runs; rejects with the node's refusal (a missing `cwd`, a program not on
   * `PATH`, the node's process limit) or when the node is not reached. */
  static async start(node: NodeClient, { cwd, argv, command, env, maxLineBytes, signal }: NodeProcessSpec, handle: Omit<HandleOptions, "maxLineBytes" | "signal"> = {}): Promise<NodeProcess> {
    signal?.throwIfAborted();
    const id = crypto.randomUUID();
    const stream = await node.openStream("process.start", {
      cwd, processId: id, ...(argv ? { argv } : { command: command ?? "" }), ...(env ? { env } : {}),
    }, { timeoutMs: START_TIMEOUT_MS });
    const started = new NodeProcess(node, id, stream.result.pid, { offset: 0, input: 0 }, { ...handle, ...(maxLineBytes === undefined ? {} : { maxLineBytes }), ...(signal ? { signal } : {}) });
    void started.read(stream);
    return started;
  }

  /** A process started before (by an earlier app), from `offset` of its output; its writes go on from where its
   * stdin is. Rejects `not_found` when its node no longer has it, and when the node is not reached. */
  static async attach(node: NodeClient, { processId, offset }: { processId: string; offset: number }, handle: HandleOptions = {}): Promise<NodeProcess> {
    handle.signal?.throwIfAborted();
    const stream = await node.openStream("process.attach", { processId, offset }, { timeoutMs: START_TIMEOUT_MS });
    const attached = new NodeProcess(node, processId, stream.result.pid, stream.result, handle);
    attached.lostBytes = stream.result.lost;
    void attached.read(stream);
    return attached;
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
          const chunk = bytes.subarray(start, start + WRITE_CHUNK_BYTES);
          await this.send({ data: chunk.toString("base64") });
          this.inputOffset += chunk.byteLength;
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

  /** The last `STDERR_TAIL_CHARS` of its stderr. */
  stderrTail(): string { return this.stderr.text; }

  /** Hears its stderr as it comes, from when it is added. */
  onStderr(listener: (text: string) => void): () => void {
    this.stderrListeners.add(listener);
    return () => { this.stderrListeners.delete(listener); };
  }

  /** Stdin closed, then SIGTERM to its process group, then SIGKILL after the node's grace period; resolves
   * once it has ended. Sent again while its node is not reached, within the grace period. */
  async stop(): Promise<NodeProcessExit> {
    if (!this.ended) {
      // Unknown: it ended, and `exited` says how.
      await this.resend(() => this.node.request("process.stop", { processId: this.id }, { timeoutMs: START_TIMEOUT_MS })).catch(() => undefined);
    }
    return this.exited;
  }

  /** Lets go of the process without stopping it: nothing more is read or written here, `exited` resolves
   * `detached`, and the node keeps it for its grace period, for another app (or this one, again) to attach to. */
  detach(): void {
    if (this.ended) return;
    this.detached = true;
    this.wake.abort();
    void this.reading?.cancel().catch(() => undefined);
    this.finish({ code: null, signal: null, detached: true });
  }

  /** Reads `stream`, then each stream it attaches again, until the process ends or is detached. */
  private async read(stream: NodeStream<unknown>): Promise<void> {
    let current: NodeStream<unknown> | null = stream;
    while (current) {
      const failure = await this.drain(current);
      if (this.detached || failure === undefined) return;
      if (!unreachable(failure)) { this.finish({ code: null, signal: null, error: this.failure ?? messageOf(failure) }); return; }
      current = await this.reattach();
    }
  }

  /** Reads one stream to its end; its failure, if any (undefined once the process ended). */
  private async drain({ body, ended }: NodeStream<unknown>): Promise<unknown> {
    const reader = body.getReader();
    this.reading = reader;
    const parser = outputParser((channel, bytes) => {
      this.offset += OUTPUT_FRAME_HEADER_BYTES + bytes.byteLength;
      if (channel === "stderr") this.heard(bytes);
      else this.deliver(bytes);
    });
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.push(value);
      }
      // A stream ends at a frame boundary; one cut inside a frame failed.
      parser.end();
      const exit = await ended;
      this.finish({ code: exit?.code ?? null, signal: exit?.signal ?? null, ...(this.failure ? { error: this.failure } : {}) });
      return undefined;
    } catch (error) {
      ended.catch(() => undefined);
      await reader.cancel().catch(() => undefined);
      return error;
    }
  }

  /** On whichever link its node has, from where its output was read to. */
  private async reattach(): Promise<NodeStream<unknown> | null> {
    try {
      const opened = await this.resend(() => this.node.openStream("process.attach", { processId: this.id, offset: this.offset }, { timeoutMs: START_TIMEOUT_MS }));
      if (this.detached) { void opened.body.cancel().catch(() => undefined); return null; }
      this.offset = opened.result.offset;
      this.lostBytes += opened.result.lost;
      return opened;
    } catch (error) {
      if (this.detached) return null;
      const why = refusal(error)?.code === "not_found" ? LOST_ERROR : `Its node did not come back within ${PROCESS_REATTACH_WINDOW_MS / 1000} s: ${messageOf(error)}`;
      this.finish({ code: null, signal: null, error: this.failure ?? why });
      return null;
    }
  }

  /** `call`, sent again while the node is not reached, for up to the node's grace period. */
  private async resend<T>(call: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + PROCESS_REATTACH_WINDOW_MS;
    for (let attempt = 0; ; attempt++) {
      try { return await call(); }
      catch (error) {
        if (!unreachable(error) || this.detached || Date.now() >= deadline) throw error;
        await sleep(backoff(attempt), this.wake.signal);
      }
    }
  }

  private queue(work: () => Promise<void>): Promise<void> {
    const done = this.input.then(work);
    this.input = done.catch(() => undefined);
    return done;
  }

  /** At its input offset, so a write sent again (its answer lost) is not taken twice. */
  private async send(input: { data?: string; end?: boolean }): Promise<void> {
    if (this.detached) throw new Error("The process was detached");
    try {
      await this.resend(() => this.node.request("process.write", { processId: this.id, offset: this.inputOffset, ...input }, { timeoutMs: PROCESS_WRITE_TIMEOUT_MS }));
    } catch (error) {
      const refused = refusal(error);
      if (refused?.code === "not_found") throw new Error("The process has exited", { cause: error });
      throw new Error(refused?.message ?? messageOf(error), { cause: error });
    }
  }

  /** Stops it with a reason of the server's: `exited` carries it. */
  private fail(reason: string): void {
    this.failure ??= reason;
    void this.stop();
  }

  private deliver(bytes: Uint8Array): void {
    if (this.stdoutCancelled) return;
    this.stdoutController.enqueue(bytes.slice());
    if ((this.stdoutController.desiredSize ?? 0) < 0) {
      const failure = `Its stdout exceeded its ${MAX_STREAM_BUFFER_BYTES}-byte buffer: nobody is reading it`;
      this.stdoutCancelled = true;
      this.stdoutController.error(new Error(failure));
      this.fail(failure);
    }
  }

  private heard(bytes: Uint8Array): void {
    const text = this.stderr.add(bytes);
    for (const listener of this.stderrListeners) {
      try { listener(text); } catch (error) { logger.warn(`A process's stderr listener threw: ${messageOf(error)}`); }
    }
  }

  private finish(exit: NodeProcessExit): void {
    if (this.ended) return;
    this.ended = true;
    if (!this.stdoutCancelled) {
      if (exit.error && !exit.detached) this.stdoutController.error(new Error(exit.error));
      else this.stdoutController.close();
    }
    this.settle(exit);
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
    const failure = `A line of its stdout was longer than ${this.maxLineBytes} bytes`;
    this.fail(failure);
    void (async () => { while (!(await reader.read()).done); })().catch(() => undefined);
    throw new Error(failure);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }
  });
}

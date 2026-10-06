/**
 * The node end of streams (see node-transport.md *Streams*). A server→node request opens a stream: its
 * params carry the `streamId` the server allocated (registered before the request is sent, so chunks
 * arriving with or before the reply are kept), and its handler starts the stream with `serve`. The node
 * then sends the source as `stream.data` notifications in order and ends with `stream.end`;
 * `stream.cancel` or the connection closing stops it, after which nothing more is sent. A process
 * stream's source returns the process's exit when it finishes, which `stream.end` carries.
 *
 * Backpressure is local: a chunk is sent only once the socket has written out everything sent before it
 * (`drained`), then the sender yields a macrotask, so other frames (storage commits, reports, replies,
 * heartbeats) interleave between chunks and the uncapped outbound queue holds about one chunk of a stream.
 */
import { STREAM_CHUNK_BYTES, type ProcessExit } from "./fields.js";
import { MAX_ERROR_MESSAGE } from "./rpc.js";
import type { StreamData, StreamEnd } from "./server-methods.js";

/** A stream's content. In a text stream, text or bytes decoded as UTF-8 (invalid sequences become
 * U+FFFD); in a binary stream, bytes (text is sent as its UTF-8) crossing as base64. Each item is sent as
 * one chunk, or several when it is over `STREAM_CHUNK_BYTES`. A `ReadableStream` is one. What the
 * iteration returns, if anything, is the stream's `exit` (a process stream). */
export type StreamSource = AsyncIterable<string | Uint8Array, ProcessExit | void>;
/** Starts a stream's source. `signal` aborts when the stream is cancelled or its connection closes:
 * stop the producer then (e.g. kill its process). The sender also finishes the iteration (`return()`:
 * a generator runs its `finally`, a `ReadableStream` is cancelled). */
export type OpenStreamSource = (signal: AbortSignal) => StreamSource;

/** The sender's connection: `data` and `end` return false when the frame was not sent. */
export interface StreamLink {
  data(input: StreamData): boolean;
  end(input: StreamEnd): boolean;
  /** See `WireSocket.drained`. */
  drained(): Promise<void>;
}

const macrotask = () => new Promise<void>(resolve => { setImmediate(resolve); });

/** The streams one connection serves. */
export function createStreamSender(link: StreamLink) {
  const open = new Map<string, AbortController>();
  return {
    /** Sends `source` as stream `streamId`. Resolves once the stream ended, failed or was stopped and its
     * source finished; never rejects. Throws when `streamId` is already open on this connection. */
    serve(streamId: string, source: OpenStreamSource, { binary = false }: { binary?: boolean } = {}): Promise<void> {
      if (open.has(streamId)) throw new Error(`Stream ${streamId} is already open`);
      const controller = new AbortController();
      open.set(streamId, controller);
      return pump(link, streamId, source, controller, binary).finally(() => { if (open.get(streamId) === controller) open.delete(streamId); });
    },
    /** `stream.cancel`: an unknown stream is ignored. */
    cancel(streamId: string): void { open.get(streamId)?.abort(); },
    /** The connection closed: the server failed every open stream, so stop them all. */
    close(): void {
      for (const controller of open.values()) controller.abort();
      open.clear();
    },
  };
}

async function pump(link: StreamLink, streamId: string, source: OpenStreamSource, controller: AbortController, binary: boolean): Promise<void> {
  const { signal } = controller;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const stopped = new Promise<undefined>(resolve => { signal.addEventListener("abort", () => resolve(undefined), { once: true }); });
  let offset = 0;
  /** Sends one chunk: `size` is its byte length in the stream. */
  const send = async (data: string, size: number, encoding?: "base64") => {
    if (size === 0 || signal.aborted) return;
    if (!link.data({ streamId, offset, data, ...(encoding ? { encoding } : {}) })) throw new Error("Stream chunk could not be sent");
    offset += size;
    await link.drained();
    await macrotask();
  };
  const sendText = (text: string) => send(text, Buffer.byteLength(text, "utf8"));
  let iterator: AsyncIterator<string | Uint8Array, ProcessExit | void> | undefined;
  let exit: ProcessExit | void = undefined;
  let completed = false;
  try {
    iterator = source(signal)[Symbol.asyncIterator]();
    for (;;) {
      const step = iterator.next();
      // A step abandoned by a stop may still reject.
      step.catch(() => undefined);
      const next = await Promise.race([step, stopped]);
      if (!next || signal.aborted) return;
      if (next.done) { exit = next.value; break; }
      const bytes = typeof next.value === "string" ? encoder.encode(next.value) : next.value;
      for (let start = 0; start < bytes.byteLength; start += STREAM_CHUNK_BYTES) {
        const piece = bytes.subarray(start, start + STREAM_CHUNK_BYTES);
        await (binary ? send(Buffer.from(piece.buffer, piece.byteOffset, piece.byteLength).toString("base64"), piece.byteLength, "base64") : sendText(decoder.decode(piece, { stream: true })));
        if (signal.aborted) return;
      }
    }
    completed = true;
    if (!binary) await sendText(decoder.decode());
    if (!signal.aborted) link.end({ streamId, ...(exit ? { exit } : {}) });
  } catch (error) {
    // The source failed, or a chunk could not be sent: end the stream with the error and stop the
    // producer. A stopped stream sends nothing more.
    if (!signal.aborted) link.end({ streamId, error: (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_MESSAGE) });
    controller.abort();
  } finally {
    if (!completed) await Promise.resolve().then(() => iterator?.return?.()).catch(() => undefined);
  }
}

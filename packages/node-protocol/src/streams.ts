/**
 * The node end of streams (see node-contract.md *Streams*). A server→node request opens a stream: its
 * params carry the `streamId` the server allocated (registered before the request is sent, so chunks
 * arriving with or before the reply are kept), and its handler starts the stream with `serve`. The node
 * then sends the source as `stream.data` notifications in order and ends with `stream.end`;
 * `stream.cancel` or the connection closing stops it, after which nothing more is sent.
 *
 * Backpressure is local: a chunk is sent only once the socket has written out everything sent before it
 * (`drained`), then the sender yields a macrotask, so other frames (storage commits, reports, replies,
 * heartbeats) interleave between chunks and the uncapped outbound queue holds about one chunk of a stream.
 */
import { STREAM_CHUNK_BYTES } from "./fields.js";
import { MAX_ERROR_MESSAGE } from "./rpc.js";
import type { StreamData, StreamEnd } from "./server-methods.js";

/** A stream's content: text, or bytes decoded as UTF-8 (invalid sequences become U+FFFD). Each item is
 * sent as one chunk, or several when it is over `STREAM_CHUNK_BYTES`. A `ReadableStream` is one. */
export type StreamSource = AsyncIterable<string | Uint8Array>;
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
    serve(streamId: string, source: OpenStreamSource): Promise<void> {
      if (open.has(streamId)) throw new Error(`Stream ${streamId} is already open`);
      const controller = new AbortController();
      open.set(streamId, controller);
      return pump(link, streamId, source, controller).finally(() => { if (open.get(streamId) === controller) open.delete(streamId); });
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

async function pump(link: StreamLink, streamId: string, source: OpenStreamSource, controller: AbortController): Promise<void> {
  const { signal } = controller;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const stopped = new Promise<undefined>(resolve => { signal.addEventListener("abort", () => resolve(undefined), { once: true }); });
  let offset = 0;
  const send = async (data: string) => {
    if (data === "" || signal.aborted) return;
    if (!link.data({ streamId, offset, data })) throw new Error("Stream chunk could not be sent");
    offset += Buffer.byteLength(data, "utf8");
    await link.drained();
    await macrotask();
  };
  let iterator: AsyncIterator<string | Uint8Array> | undefined;
  let completed = false;
  try {
    iterator = source(signal)[Symbol.asyncIterator]();
    for (;;) {
      const step = iterator.next();
      // A step abandoned by a stop may still reject.
      step.catch(() => undefined);
      const next = await Promise.race([step, stopped]);
      if (!next || signal.aborted) return;
      if (next.done) break;
      const bytes = typeof next.value === "string" ? encoder.encode(next.value) : next.value;
      for (let start = 0; start < bytes.byteLength; start += STREAM_CHUNK_BYTES) {
        await send(decoder.decode(bytes.subarray(start, start + STREAM_CHUNK_BYTES), { stream: true }));
        if (signal.aborted) return;
      }
    }
    completed = true;
    await send(decoder.decode());
    if (!signal.aborted) link.end({ streamId });
  } catch (error) {
    // The source failed, or a chunk could not be sent: end the stream with the error and stop the
    // producer. A stopped stream sends nothing more.
    if (!signal.aborted) link.end({ streamId, error: (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_MESSAGE) });
    controller.abort();
  } finally {
    if (!completed) await Promise.resolve().then(() => iterator?.return?.()).catch(() => undefined);
  }
}

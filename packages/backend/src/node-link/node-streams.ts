import { RpcFailure, type ProcessExit, type StreamData, type StreamEnd } from "@reins/node-protocol";
import { logger } from "../logger.js";

/** Bytes a stream may buffer on the server before its consumer reads them. There is no flow control
 * on the wire: a stream whose consumer falls this far behind fails rather than growing without bound. */
export const MAX_STREAM_BUFFER_BYTES = 64 * 1024 * 1024;

/** An open stream: the opening request's result and the stream's bytes (a text stream's UTF-8), which
 * an HTTP route can return as a `Response` body. Cancelling the body cancels the stream on the node.
 * `ended` resolves when the stream ended, with its process's exit for a process stream, and rejects with
 * the error that failed it (also a cancelled body). */
export interface NodeStream<T> { result: T; body: ReadableStream<Uint8Array>; ended: Promise<ProcessExit | undefined> }

interface OpenStream {
  controller: ReadableStreamDefaultController<Uint8Array>;
  received: number;
  settle: { resolve(exit: ProcessExit | undefined): void; reject(error: Error): void };
}

/**
 * The server end of the streams one node connection carries (see node-transport.md *Streams*). The server
 * allocates each stream's ID and registers it before the opening request is sent, so chunks that arrive
 * with or before the reply are kept. Chunks are buffered in the body's queue until the consumer reads
 * them, at most `maxBufferedBytes` per stream. A failure of one stream (its buffer cap, an offset gap,
 * a refused opening request) fails only that stream and tells the node to cancel it; `close` (the link
 * dropped) fails every stream still open.
 */
export function createStreamRegistry(cancel: (streamId: string) => void, { maxBufferedBytes = MAX_STREAM_BUFFER_BYTES }: { maxBufferedBytes?: number } = {}) {
  const streams = new Map<string, OpenStream>();
  const encoder = new TextEncoder();
  let closed = false;
  const fail = (streamId: string, stream: OpenStream, error: Error) => {
    streams.delete(streamId);
    stream.controller.error(error);
    stream.settle.reject(error);
    cancel(streamId);
  };
  return {
    /** Opens a stream: `start` sends the opening request carrying `streamId`. Resolves once the node
     * accepted it; a refusal rejects with `start`'s error (and the node is told to cancel, in case the
     * outcome was unknown and it started). */
    async open<T>(start: (streamId: string) => Promise<T>): Promise<NodeStream<T>> {
      if (closed) throw new RpcFailure("unavailable", "Node connection closed");
      const streamId = crypto.randomUUID();
      const ended = Promise.withResolvers<ProcessExit | undefined>();
      // A consumer that only reads the body need not await `ended`.
      ended.promise.catch(() => undefined);
      let stream!: OpenStream;
      const body = new ReadableStream<Uint8Array>({
        start(controller) { stream = { controller, received: 0, settle: ended }; },
        cancel() {
          if (streams.get(streamId) !== stream) return;
          streams.delete(streamId);
          ended.reject(new Error("Stream cancelled"));
          cancel(streamId);
        },
      }, { highWaterMark: maxBufferedBytes, size: chunk => chunk?.byteLength ?? 0 });
      streams.set(streamId, stream);
      try { return { result: await start(streamId), body, ended: ended.promise }; }
      catch (error) {
        if (streams.get(streamId) === stream) fail(streamId, stream, error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
    },
    /** `stream.data`: a chunk for a stream that is not open (cancelled, failed or never opened) is
     * dropped and the node told to cancel it. */
    data({ streamId, offset, data, encoding }: StreamData): void {
      const stream = streams.get(streamId);
      if (!stream) { logger.debug(`Dropped a chunk of stream ${streamId}: not open`); cancel(streamId); return; }
      if (offset !== stream.received) { fail(streamId, stream, new Error(`Stream ${streamId} offset gap: expected byte ${stream.received}, got ${offset}`)); return; }
      const bytes = encoding === "base64" ? new Uint8Array(Buffer.from(data, "base64")) : encoder.encode(data);
      stream.received += bytes.byteLength;
      stream.controller.enqueue(bytes);
      if ((stream.controller.desiredSize ?? 0) < 0) fail(streamId, stream, new Error(`Stream exceeded its ${maxBufferedBytes}-byte buffer: the consumer is not reading it`));
    },
    /** `stream.end`: the stream's last frame. */
    end({ streamId, error, exit }: StreamEnd): void {
      const stream = streams.get(streamId);
      if (!stream) return;
      streams.delete(streamId);
      if (error === undefined) { stream.controller.close(); stream.settle.resolve(exit); return; }
      stream.controller.error(new Error(error));
      stream.settle.reject(new Error(error));
    },
    /** The connection closed: every open stream fails. */
    close(): void {
      closed = true;
      // Like a call in flight when its connection closes: the node may have produced more.
      const error = new RpcFailure("unavailable", "Node connection closed", "unknown");
      for (const stream of streams.values()) { stream.controller.error(error); stream.settle.reject(error); }
      streams.clear();
    },
  };
}

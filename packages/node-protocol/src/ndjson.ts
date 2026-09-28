import type { Socket, SocketHandler } from "bun";
import type { WireSocket } from "./peer.js";

/** The byte stream under an NDJSON link (a Bun socket, or a fake in tests). `write` may accept fewer
 * bytes than given (0 when the kernel buffer is full, negative when closed); the caller writes the rest
 * after `drain`. */
export interface ByteStream { write(data: Uint8Array): number; end(): void }

export interface NdjsonSocket extends WireSocket {
  onmessage?: (data: string) => void;
  onclose?: () => void;
  readonly closed: boolean;
  /** Outbound bytes accepted by `send` and not yet written to the stream. */
  readonly queuedBytes: number;
  /** Feed every chunk from the stream's data callback. */
  receive(chunk: Uint8Array): void;
  /** Call from the stream's drain callback. */
  drain(): void;
  /** Call when the stream ends, errors or closes: the socket closes without writing anything more. */
  ended(): void;
}

const NEWLINE = 0x0a;

/**
 * JSON-RPC frames over a byte stream, one per line: each frame is the UTF-8 of a `JSON.stringify` string
 * (which never contains a raw newline: `send` rejects one) followed by `\n`.
 *
 * - *Receiving:* chunks are split on the newline byte, which never occurs inside a multi-byte UTF-8
 *   sequence, so a frame split anywhere (mid-character included) is reassembled from its bytes and
 *   decoded whole with a fatal decoder; a chunk may carry several frames. Invalid UTF-8 closes.
 * - *Bound:* a frame whose bytes (without the newline) exceed `maxFrameBytes` closes the socket as soon
 *   as the partial frame crosses the cap, so memory stays bounded by the cap.
 * - *Backpressure:* bytes the stream does not accept are queued in order and written on `drain`;
 *   later frames queue behind them.
 * - *Close:* `close()` or `ended()` closes once, drops queued outbound bytes, ends the stream and calls
 *   `onclose` asynchronously (as the in-memory loopback does).
 */
export function createNdjsonSocket(stream: ByteStream, { maxFrameBytes }: { maxFrameBytes: number }): NdjsonSocket {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let closed = false;
  const parts: Uint8Array[] = [];
  let partBytes = 0;
  const queue: Uint8Array[] = [];
  let queuedBytes = 0;
  const shut = () => {
    if (closed) return;
    closed = true;
    queue.length = 0; queuedBytes = 0; parts.length = 0; partBytes = 0;
    try { stream.end(); } catch { /* already gone */ }
    queueMicrotask(() => socket.onclose?.());
  };
  /** Writes queued bytes until the stream stops accepting them. */
  const flush = () => {
    while (queue.length > 0 && !socket.closed) {
      const head = queue[0]!;
      let written: number;
      try { written = stream.write(head); } catch { shut(); return; }
      if (written < 0) { shut(); return; }
      queuedBytes -= written;
      if (written < head.byteLength) { queue[0] = head.subarray(written); return; }
      queue.shift();
    }
  };
  const overflow = () => {
    console.warn(`NDJSON frame exceeds ${maxFrameBytes} bytes; closing the connection`);
    shut();
  };
  const socket: NdjsonSocket = {
    onmessage: undefined,
    onclose: undefined,
    get closed() { return closed; },
    get queuedBytes() { return queuedBytes; },
    send(data) {
      if (closed) throw new Error("NDJSON socket closed");
      if (typeof data !== "string") throw new TypeError("NDJSON frames must be strings");
      if (data.includes("\n")) throw new TypeError("NDJSON frames must not contain a newline");
      const bytes = encoder.encode(`${data}\n`);
      if (bytes.byteLength - 1 > maxFrameBytes) throw new RangeError(`NDJSON frame exceeds ${maxFrameBytes} bytes`);
      queue.push(bytes);
      queuedBytes += bytes.byteLength;
      if (queue.length === 1) flush();
    },
    close: shut,
    ended: shut,
    drain: flush,
    receive(chunk) {
      let start = 0;
      while (!socket.closed && start < chunk.byteLength) {
        const end = chunk.indexOf(NEWLINE, start);
        const piece = chunk.subarray(start, end < 0 ? chunk.byteLength : end);
        if (partBytes + piece.byteLength > maxFrameBytes) { overflow(); return; }
        if (end < 0) {
          // The chunk's buffer may be reused by the stream after this callback: keep a copy.
          parts.push(new Uint8Array(piece));
          partBytes += piece.byteLength;
          return;
        }
        start = end + 1;
        const frame = parts.length === 0 ? piece : Buffer.concat([...parts, piece]);
        parts.length = 0; partBytes = 0;
        let text: string;
        try { text = decoder.decode(frame); }
        catch { console.warn("NDJSON frame is not valid UTF-8; closing the connection"); shut(); return; }
        socket.onmessage?.(text);
      }
    },
  };
  return socket;
}

/**
 * Bun socket callbacks (for `Bun.listen` and `Bun.connect`) that wrap every socket in an NDJSON socket,
 * stored as the Bun socket's `data`, and hand it to `opened` for wiring before any data arrives.
 */
export function ndjsonSocketHandler(maxFrameBytes: number, opened: (socket: NdjsonSocket) => void): SocketHandler<NdjsonSocket | undefined> {
  return {
    open(raw: Socket<NdjsonSocket | undefined>) {
      raw.data = createNdjsonSocket({ write: bytes => raw.write(bytes), end: () => raw.end() }, { maxFrameBytes });
      opened(raw.data);
    },
    data(raw, chunk) { raw.data?.receive(chunk); },
    drain(raw) { raw.data?.drain(); },
    end(raw) { raw.data?.ended(); },
    close(raw) { raw.data?.ended(); },
    error(raw) { raw.data?.ended(); },
  };
}

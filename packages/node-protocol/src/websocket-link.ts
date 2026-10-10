/**
 * The remote node link: JSON-RPC over a WebSocket at `/node-link` on the server's HTTP server, one text
 * message per frame. Its constants, the URL a node dials and the socket adapter both ends wrap their
 * WebSocket in (Bun's server socket on the server, the global `WebSocket` on the node). See
 * docs/dev/node-transport.md *The WebSocket link*.
 */
import { HEARTBEAT, HELLO_TIMEOUT_MS, type LinkOptions } from "./local-socket.js";
import type { LinkSocket } from "./rpc.js";

/** Frame cap on the remote link, both ways: the server's `maxPayloadLength` and the node's socket
 * adapter close on a longer inbound message; the peer refuses to send one (`FRAME_TOO_LARGE`). Storage
 * calls cross in slices below it; prompts are bounded to fit it (`MAX_PROMPT_CONTENT_BYTES`). */
export const REMOTE_MAX_FRAME_BYTES = 16 * 1024 * 1024;
/** Connection options for either end of the remote link: the local link's heartbeat and hello timeout,
 * with the remote cap. */
export const REMOTE_LINK: LinkOptions = { maxFrameBytes: REMOTE_MAX_FRAME_BYTES, heartbeat: HEARTBEAT, helloTimeoutMs: HELLO_TIMEOUT_MS };
/** The path of the remote link on the server's HTTP server, separate from the browser's `/ws`. */
export const NODE_LINK_PATH = "/node-link";

/** The WebSocket URL a node paired with `serverUrl` (an http(s) URL, possibly with a path) dials: `ws://`
 * for http, `wss://` for https, at `/node-link` under its path. */
export function nodeLinkUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Not an http(s) server URL: ${url.protocol}`);
  const scheme = url.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${url.host}${url.pathname.replace(/\/+$/, "")}${NODE_LINK_PATH}`;
}

/** One WebSocket as the link drives it. */
export interface MessageStream {
  /** Sends one text message: its byte count when written out, -1 when accepted but held (the adapter
   * sends nothing more until `drain` finds nothing held), 0 when dropped (the link closes). */
  send(text: string): number;
  /** Bytes the WebSocket holds unsent. */
  bufferedAmount(): number;
  close(code?: number, reason?: string): void;
}

export interface WebSocketLink extends LinkSocket {
  /** Resolves once every frame sent so far was handed to the WebSocket and it holds nothing unsent. */
  drained(): Promise<void>;
  /** Feed every inbound message. */
  receive(message: string | ArrayBuffer | Uint8Array): void;
  /** Call when the WebSocket may have written out what it held (Bun's server `drain` event; the node polls). */
  drain(): void;
  /** Call when the WebSocket closes or errors: the link closes without sending anything more. */
  ended(): void;
}

/** Close codes (RFC 6455). */
const UNSUPPORTED_DATA = 1003;
const MESSAGE_TOO_BIG = 1009;

/**
 * JSON-RPC frames over a WebSocket, one text message each.
 *
 * - *Backpressure:* a frame goes to the WebSocket only while it holds nothing unsent; once a send is
 *   held (-1), later frames wait here, in order, until a `drain` finds the WebSocket empty. So the
 *   WebSocket holds at most one frame beyond what it had written, and Bun's server socket, which drops a
 *   message sent while more than its backpressure limit (16 MiB) is pending, never drops one. A dropped
 *   message (0) closes the link anyway: the protocol cannot lose a frame. The queue here is not capped:
 *   the heartbeat closes a peer that stops reading, and streams pace themselves with `drained()`.
 * - *Bound:* an inbound message whose UTF-8 is longer than `maxFrameBytes`, or a binary one, closes the
 *   link (1009, 1003); `send` refuses a longer frame (the peer checks first, `FRAME_TOO_LARGE`).
 * - *Close:* `close()` or `ended()` closes once, drops queued frames, closes the WebSocket and calls
 *   `onclose` asynchronously, as the NDJSON socket does.
 */
export function createWebSocketLink(stream: MessageStream, { maxFrameBytes }: { maxFrameBytes: number }): WebSocketLink {
  let closed = false;
  const queue: string[] = [];
  const drainWaiters: Array<() => void> = [];
  const idle = () => queue.length === 0 && stream.bufferedAmount() === 0;
  const settleWaiters = () => { for (const resolve of drainWaiters.splice(0)) resolve(); };
  const shut = (code?: number, reason?: string) => {
    if (closed) return;
    closed = true;
    queue.length = 0;
    settleWaiters();
    try { stream.close(code, reason); } catch { /* already gone */ }
    queueMicrotask(() => link.onclose?.());
  };
  /** Sends queued frames while the WebSocket holds nothing unsent. */
  const flush = () => {
    while (queue.length > 0 && !link.closed) {
      if (stream.bufferedAmount() > 0) return;
      let sent: number;
      try { sent = stream.send(queue[0]!); } catch { shut(); return; }
      if (sent === 0) { console.warn("WebSocket dropped a frame; closing the connection"); shut(); return; }
      queue.shift();
    }
    if (!closed && idle()) settleWaiters();
  };
  const link: WebSocketLink = {
    onmessage: undefined,
    onclose: undefined,
    get closed() { return closed; },
    send(data) {
      if (closed) throw new Error("WebSocket link closed");
      if (typeof data !== "string") throw new TypeError("WebSocket link frames must be strings");
      if (Buffer.byteLength(data, "utf8") > maxFrameBytes) throw new RangeError(`WebSocket frame exceeds ${maxFrameBytes} bytes`);
      queue.push(data);
      if (queue.length === 1) flush();
    },
    close: () => shut(),
    ended: () => shut(),
    drain: flush,
    drained: () => closed || idle() ? Promise.resolve() : new Promise(resolve => { drainWaiters.push(resolve); }),
    receive(message) {
      if (closed) return;
      if (typeof message !== "string") {
        console.warn("WebSocket link received a binary message; closing the connection");
        shut(UNSUPPORTED_DATA, "Text frames only");
        return;
      }
      if (Buffer.byteLength(message, "utf8") > maxFrameBytes) {
        console.warn(`WebSocket message exceeds ${maxFrameBytes} bytes; closing the connection`);
        shut(MESSAGE_TOO_BIG, "Frame too large");
        return;
      }
      link.onmessage?.(message);
    },
  };
  return link;
}

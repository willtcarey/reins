import type { Transport } from "./node-connection.js";
import { createWebSocketLink, nodeLinkUrl, REMOTE_LINK, REMOTE_MAX_FRAME_BYTES, type LinkOptions, type LinkSocket, type MessageStream, type WebSocketLink } from "@reins/node-protocol";

/** A dial that has not opened by then is abandoned and redialed (an unreachable host can otherwise hold a
 * TCP connect for minutes). */
const DIAL_TIMEOUT_MS = 10_000;
/** Bun's client WebSocket has no drain event: a backpressured link polls `bufferedAmount` this often. */
const DRAIN_POLL_MS = 10;

/**
 * The remote link's transport (`connectNode`'s): the `/nodes/link` WebSocket of the server at `serverUrl`
 * (a paired node's, http or https: `ws://` or `wss://`), with the remote link's options (`REMOTE_LINK`,
 * `overrides` over them). Every connection there is challenged: the node answers with its `key`. See
 * node-transport.md *1b. The WebSocket link*.
 */
export function webSocketTransport(serverUrl: string, overrides: LinkOptions = {}, { dialTimeoutMs = DIAL_TIMEOUT_MS }: { dialTimeoutMs?: number } = {}): Transport {
  const link: LinkOptions = { ...REMOTE_LINK, ...overrides };
  const url = nodeLinkUrl(serverUrl);
  return { address: url, link, open: opened => dialWebSocket(url, link.maxFrameBytes ?? REMOTE_MAX_FRAME_BYTES, dialTimeoutMs, opened) };
}

/** Rejects when the WebSocket closes before opening, or has not opened within `dialTimeoutMs`. */
function dialWebSocket(url: string, maxFrameBytes: number, dialTimeoutMs: number, opened: (wire: LinkSocket) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    let wire: WebSocketLink | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    const stopPolling = () => { clearInterval(poll); poll = undefined; };
    let timedOut = false;
    // Rejected here, not by its close: Bun 1.3.9 never fires close for a WebSocket closed while connecting,
    // which would leave the dial unsettled and the node never dialing again.
    const timeout = setTimeout(() => {
      timedOut = true;
      ws.close();
      reject(new Error(`WebSocket to ${url} did not open within ${dialTimeoutMs / 1000} s`));
    }, dialTimeoutMs);
    const stream: MessageStream = {
      send(text) {
        ws.send(text);
        if (ws.bufferedAmount === 0) return Buffer.byteLength(text, "utf8");
        poll ??= setInterval(() => { if (ws.bufferedAmount === 0) { stopPolling(); wire?.drain(); } }, DRAIN_POLL_MS);
        return -1;
      },
      bufferedAmount: () => ws.bufferedAmount,
      // A client may close only with 1000 or 3000–4999, so the link's own codes stay on the server side.
      close: () => { stopPolling(); ws.close(); },
    };
    ws.onopen = () => {
      if (timedOut) { ws.close(); return; }
      clearTimeout(timeout);
      wire = createWebSocketLink(stream, { maxFrameBytes });
      opened(wire);
      resolve();
    };
    ws.onmessage = event => wire?.receive(event.data);
    ws.onclose = event => {
      clearTimeout(timeout);
      stopPolling();
      if (wire) wire.ended();
      // Bun's reason, e.g. "Expected 101 status code" for a server answering 503 while it reloads.
      else if (!timedOut) reject(new Error(`WebSocket to ${url} closed before opening${event.reason ? ` (${event.reason})` : ""}`));
    };
  });
}

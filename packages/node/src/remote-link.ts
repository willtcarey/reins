import type { Node } from "./node.js";
import { redialNode, type NodeLinkClient, type RedialOptions } from "./redial.js";
import { createWebSocketLink, nodeLinkUrl, REMOTE_LINK, REMOTE_MAX_FRAME_BYTES, type LinkOptions, type LinkSocket, type MessageStream, type NodeIdentity, type WebSocketLink } from "@reins/node-protocol";

/** A dial that has not opened by then is abandoned and redialed (an unreachable host can otherwise hold a
 * TCP connect for minutes). */
const DIAL_TIMEOUT_MS = 10_000;
/** Bun's client WebSocket has no drain event: a backpressured link polls `bufferedAmount` this often. */
const DRAIN_POLL_MS = 10;

interface RemoteNodeClientOptions extends LinkOptions, RedialOptions {
  /** The server the node was paired with (`node.json`'s `serverUrl`, http or https). */
  serverUrl: string;
  /** Announced in `node.hello`: the node ID the server gave this node at pairing. */
  nodeId: string;
  /** The node's key and the server origin it signs for (`loadNodeIdentity`), to answer the challenge. */
  identity: NodeIdentity;
}

/**
 * Node side of the remote link: dials the server's `/node-link` WebSocket (`ws://` for an http server,
 * `wss://` for https), answers its challenge with the node's key and runs the node protocol, redialing
 * with backoff and stopping on a refusal (`redialNode`). See node-transport.md *The WebSocket link*.
 */
export function connectRemoteNode(node: Node, options: RemoteNodeClientOptions): NodeLinkClient {
  const { serverUrl, nodeId, identity, backoff, random, onStatus, onRefused, ...overrides } = options;
  const link: LinkOptions = { ...REMOTE_LINK, ...overrides };
  const url = nodeLinkUrl(serverUrl);
  return redialNode(node, opened => dialWebSocket(url, link.maxFrameBytes ?? REMOTE_MAX_FRAME_BYTES, opened), nodeId, { ...link, identity }, { backoff, random, onStatus, onRefused });
}

/** Opens one WebSocket to `url` and hands it to `opened` as a link socket; rejects when it closes, or has
 * not opened within `DIAL_TIMEOUT_MS`, before opening. */
function dialWebSocket(url: string, maxFrameBytes: number, opened: (wire: LinkSocket) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    let wire: WebSocketLink | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    const stopPolling = () => { clearInterval(poll); poll = undefined; };
    const timeout = setTimeout(() => ws.close(), DIAL_TIMEOUT_MS);
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
      clearTimeout(timeout);
      wire = createWebSocketLink(stream, { maxFrameBytes });
      opened(wire);
      resolve();
    };
    ws.onmessage = event => wire?.receive(event.data);
    ws.onclose = () => {
      clearTimeout(timeout);
      stopPolling();
      if (wire) wire.ended();
      else reject(new Error(`WebSocket to ${url} closed before opening`));
    };
  });
}

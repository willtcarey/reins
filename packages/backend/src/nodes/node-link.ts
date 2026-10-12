/**
 * The server end of the remote node link: `/nodes/link` on the server's HTTP server (its route is
 * routes/nodes.ts), JSON-RPC over a
 * WebSocket (node-transport.md *The WebSocket link*). Separate from the browser's `/ws`: it reads no
 * cookies, and every connection must authenticate as a paired node before its hello is answered
 * (`node.authenticate`, ADR-023), signed for the server origin the node dialed (ADR-024).
 *
 * The process owner's HTTP server performs the upgrade, but the socket belongs to the app that
 * upgraded it: its handlers travel in the upgrade data (`UpgradeData`), and `close` (a reload or process
 * exit) closes every socket the app accepted. The node redials the next app.
 */
import { createWebSocketLink, REMOTE_LINK, REMOTE_MAX_FRAME_BYTES, type WebSocketLink } from "@reins/node-protocol";
import type { AcceptOptions, NodeSocket, SocketHandlers, UpgradeServer } from "../state.js";

export interface NodeLinks {
  /** Upgrades a `/nodes/link` request to a WebSocket whose node link this app's hub serves: undefined
   * once upgraded (Bun answers the request), else the refusal (426 not an upgrade, 400 no usable host,
   * 503 once closed). */
  upgrade(request: Request, server: UpgradeServer): Response | undefined;
  /** Closes every connection accepted here, negotiated or not, and refuses later upgrades. */
  close(): void;
}

/** `/nodes/link` for one app: each WebSocket it upgrades is handed to `accept` (the app's hub)
 * as soon as it opens, so the server's challenge is the connection's first frame. */
export function createNodeLinks(accept: (socket: NodeSocket, options: AcceptOptions) => void): NodeLinks {
  let closed = false;
  const open = new Set<WebSocketLink>();
  return {
    upgrade(request, server) {
      if (closed) return new Response("Server reloading", { status: 503 });
      const origin = requestOrigin(request);
      if (!origin) return new Response("No usable Host header", { status: 400 });
      let wire: WebSocketLink | undefined;
      const handlers: SocketHandlers = {
        open(ws) {
          wire = createWebSocketLink({
            send: text => ws.send(text),
            bufferedAmount: () => ws.getBufferedAmount(),
            close: (code, reason) => ws.close(code, reason),
          }, { maxFrameBytes: REMOTE_MAX_FRAME_BYTES });
          if (closed) { wire.close(); return; }
          open.add(wire);
          accept(wire, { ...REMOTE_LINK, authenticate: { origin } });
        },
        message(_ws, message) { wire?.receive(message); },
        drain() { wire?.drain(); },
        close() {
          if (!wire) return;
          open.delete(wire);
          wire.ended();
        },
      };
      if (server.upgrade(request, { data: { handlers } })) return undefined;
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    },
    close() {
      closed = true;
      for (const wire of open) wire.close();
      open.clear();
    },
  };
}

/**
 * The server origin a node dialing this request signed for (ADR-024): the scheme of `X-Forwarded-Proto`
 * else the request's, the host of `X-Forwarded-Host` else `Host` (each header's first value, as proxies
 * append theirs), as an http(s) origin: a node signs its configured http(s) server URL's origin while
 * dialing ws(s). Null when the host does not make a URL. The install script (`/nodes/install`,
 * node-bundle/delivery.ts) names the server by it too.
 */
export function requestOrigin(request: Request): string | null {
  const first = (name: string) => request.headers.get(name)?.split(",")[0]?.trim() || undefined;
  const url = new URL(request.url);
  const scheme = (first("x-forwarded-proto") ?? url.protocol.slice(0, -1)).toLowerCase();
  const secure = scheme === "https" || scheme === "wss";
  const host = first("x-forwarded-host") ?? first("host") ?? url.host;
  const candidate = `${secure ? "https" : "http"}://${host}`;
  // A host only: nothing that would make the rest of it a path, user or query.
  if (/[\s/?#@\\]/.test(host) || !URL.canParse(candidate)) return null;
  return new URL(candidate).origin;
}

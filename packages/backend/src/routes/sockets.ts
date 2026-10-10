/**
 * WebSocket Routes
 *
 * The browser's socket (`/ws`) and a remote node's link (`/node-link`). Each answers undefined once it
 * upgraded the request (Bun answers it), else its refusal.
 */

import { NODE_LINK_PATH } from "@reins/node-protocol";
import type { RouterGroup } from "../router.js";
import type { UpgradeData } from "../state.js";
import { API } from "../api-paths.js";

export function registerSocketRoutes(router: RouterGroup) {
  // A browser socket: no handlers of its own, so the process registers it as a client.
  router.websocket(API.ws, ({ req, server }) => {
    const data: UpgradeData = {};
    if (server.upgrade(req, { data })) return undefined;
    return new Response("WebSocket upgrade failed", { status: 400 });
  });

  // A remote node's link: driven by this load (`nodes/node-link.ts`), not registered as a browser client.
  router.websocket(NODE_LINK_PATH, ({ req, server, state }) => state.nodeLinks.upgrade(req, server));
}

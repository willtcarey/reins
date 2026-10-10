/**
 * Browser Socket Route
 *
 *   GET /ws — the browser's WebSocket: upgraded with no handlers of its own, so the process registers it as
 *             a client (server-process.ts); 400 when the upgrade fails
 *
 * A remote node's link, `/nodes/link`, is a node route (nodes.ts).
 */

import type { RouterGroup } from "../router.js";
import type { UpgradeData } from "../state.js";
import { API } from "../api-paths.js";

export function registerSocketRoutes(router: RouterGroup) {
  router.websocket(API.ws, ({ req, server }) => {
    const data: UpgradeData = {};
    if (server.upgrade(req, { data })) return undefined;
    return new Response("WebSocket upgrade failed", { status: 400 });
  });
}

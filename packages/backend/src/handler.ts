/**
 * HTTP Fetch Handler
 *
 * Thin entry point: delegates to the router for API routes,
 * handles WebSocket upgrades (the browser's `/ws`, and `/node-link` for
 * remote nodes), serves the node's install script and bundle (`/nodes/*`)
 * and static files. An /api or /nodes path no route matches is a 404,
 * never the web app's SPA fallback.
 */

import { NODE_LINK_PATH } from "@reins/node-protocol";
import type { ServerState, UpgradeData } from "./state.js";
import { buildRouter } from "./routes/index.js";
import { serveStatic } from "./static.js";

const router = buildRouter();

export async function handleFetch(
  state: ServerState,
  req: Request,
  server: any,
): Promise<Response | undefined> {
  const url = new URL(req.url);

  // A browser socket: no handlers of its own, so the process registers it as a client.
  if (url.pathname === "/ws") {
    const data: UpgradeData = {};
    const upgraded = server.upgrade(req, { data });
    if (!upgraded) {
      return new Response("WebSocket upgrade failed", { status: 400 });
    }
    return undefined;
  }
  // A remote node's link: driven by this load (`nodes/node-link.ts`), not registered as a browser client.
  if (url.pathname === NODE_LINK_PATH) return state.nodeLinks.upgrade(req, server);
  // What a remote machine installs a node from (`node-bundle/delivery.ts`).
  const nodeBundle = await state.nodeBundle.handle(req);
  if (nodeBundle) return nodeBundle;

  // API routes
  const response = await router.handle(req, state);
  if (response) return response;
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
    return Response.json({ error: `No API route ${req.method} ${url.pathname}` }, { status: 404 });
  }

  // Static file serving (frontend)
  return serveStatic(state.frontendDir, url.pathname);
}

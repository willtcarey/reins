/**
 * HTTP Fetch Handler
 *
 * Thin entry point: every endpoint is a route (`routes/`), the WebSocket upgrades (`/ws`, `/node-link`)
 * and the node's install script and bundle (`/nodes/*`) included; any other path is a static file. An
 * /api or /nodes path no route matches is a 404, never the web app's SPA fallback.
 */

import type { ServerState, UpgradeServer } from "./state.js";
import { API } from "./api-paths.js";
import { buildRouter } from "./routes/index.js";
import { serveStatic } from "./static.js";

const router = buildRouter();

/** Undefined once a route upgraded the request to a WebSocket (Bun answers it). */
export async function handleFetch(
  state: ServerState,
  req: Request,
  server: UpgradeServer,
): Promise<Response | undefined> {
  const url = new URL(req.url);

  const response = await router.handle(req, state, server);
  if (response !== null) return response;
  if (within(url.pathname, "/api")) {
    return Response.json({ error: `No API route ${req.method} ${url.pathname}` }, { status: 404 });
  }
  if (within(url.pathname, API.nodeDelivery)) {
    return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }

  // Static file serving (frontend)
  return serveStatic(state.frontendDir, url.pathname);
}

/** Whether `pathname` is `prefix` or under it. */
function within(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * HTTP Fetch Handler
 *
 * Thin entry point: delegates to the router for API routes,
 * handles WebSocket upgrades, and serves static files. An /api path no
 * route matches is a JSON 404, never the web app's SPA fallback.
 */

import type { ServerState } from "./state.js";
import { buildRouter } from "./routes/index.js";
import { serveStatic } from "./static.js";

const router = buildRouter();

export async function handleFetch(
  state: ServerState,
  req: Request,
  server: any,
): Promise<Response | undefined> {
  const url = new URL(req.url);

  // WebSocket upgrade
  if (url.pathname === "/ws") {
    const upgraded = server.upgrade(req);
    if (!upgraded) {
      return new Response("WebSocket upgrade failed", { status: 400 });
    }
    return undefined;
  }

  // API routes
  const response = await router.handle(req, state);
  if (response) return response;
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
    return Response.json({ error: `No API route ${req.method} ${url.pathname}` }, { status: 404 });
  }

  // Static file serving (frontend)
  return serveStatic(state.frontendDir, url.pathname);
}

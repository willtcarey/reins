/**
 * HTTP Fetch Handler
 *
 * Thin entry point: delegates to the router for API routes,
 * handles WebSocket upgrades, and serves static files.
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

  // Static file serving (frontend)
  return serveStatic(state.frontendDir, url.pathname);
}

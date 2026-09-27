/**
 * HTTP Fetch Handler
 *
 * Thin entry point: delegates to the router for API routes,
 * handles WebSocket upgrades, and serves static files.
 */

import type { ServerState } from "./state.js";
import { buildRouter } from "./routes/index.js";
import { installRuntimeHooks } from "./runtime-hooks.js";
import { dispatcherFor } from "./models/node-command-dispatcher.js";
import { acceptInternalNodeConnection, internalNodeFor, stopInternalNode } from "./runtimes/internal-node.js";
import { serveStatic } from "./static.js";

const router = buildRouter();

export function install(state: ServerState): () => void {
  const uninstallRuntimeHooks = installRuntimeHooks(state);
  // Loopback: start the host-local node before draining persisted commands. Socket: the node connects
  // through the process owner's listener (`acceptNodeConnection`).
  if (state.internalNodeLink !== "socket") internalNodeFor(state);
  const dispatcher = dispatcherFor(state);
  return () => {
    dispatcher.stop();
    stopInternalNode(state);
    uninstallRuntimeHooks();
  };
}

/** Local node socket connections, routed here by the process owner so each reaches the current handler. */
export const acceptNodeConnection = acceptInternalNodeConnection;

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

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
import { acceptInternalNodeConnection, closeInternalNodeLink } from "./runtimes/internal-node.js";
import { serveStatic } from "./static.js";

const router = buildRouter();

export function install(state: ServerState): () => void {
  const uninstallRuntimeHooks = installRuntimeHooks(state);
  // The server never starts a node: the node process dials the process owner's listener, which routes
  // the connection here (`acceptNodeConnection`). Until then submitted work waits in the outbox.
  const dispatcher = dispatcherFor(state);
  return () => {
    dispatcher.stop();
    // Hot reload: the node redials and reaches the newly installed handler; its runs are untouched.
    closeInternalNodeLink(state);
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

/**
 * HTTP Fetch Handler
 *
 * Thin entry point: delegates to the router for API routes,
 * handles WebSocket upgrades, and serves static files.
 */

import type { NodeSocket, ProcessState, ServerState } from "./state.js";
import { buildRouter } from "./routes/index.js";
import { installNodeHub } from "./runtimes/node-hub.js";
import { serveStatic } from "./static.js";

const router = buildRouter();

/** The handler's state (the process state with this install's node hub) and its uninstall. */
export interface InstalledHandler { state: ServerState; uninstall(): void }

/**
 * Gives the process state this handler's node hub and starts delivery. The server never starts a node:
 * nodes dial the process owner's listener, which routes each connection to the installed handler
 * (`acceptNodeConnection`). Until a session's node connects, its submitted work waits in the outbox.
 */
export function install(process: ProcessState): InstalledHandler {
  const state = installNodeHub(process);
  const hub = state.nodes;
  hub.start();
  // Hot reload: the nodes redial and reach the newly installed handler's hub; their runs are untouched.
  return { state, uninstall: () => hub.close() };
}

/** Node socket connections, routed here by the process owner so each reaches the installed handler. */
export function acceptNodeConnection(state: ServerState, socket: NodeSocket): void {
  state.nodes.accept(socket);
}

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

/**
 * Herald Backend Server (entry point)
 *
 * Owns long-lived state (sessions, clients, Bun server) and delegates
 * request handling to routes.ts and ws.ts through mutable references.
 *
 * In dev mode (HERALD_DEV=1), watches src/ for changes and hot-reloads
 * the handler module without restarting the process — agent sessions
 * stay alive mid-turn.
 */

import { getModel } from "@mariozechner/pi-ai";
import { watch } from "fs";
import { resolve } from "path";
import type { ServerState, ManagedSession, WsClient } from "./state.js";

// We import the handler types but load via dynamic import so we can reload
import type * as RoutesModule from "./routes.js";
import type * as WsModule from "./ws.js";

const PORT = parseInt(process.env.HERALD_PORT || "3100", 10);
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const EVICTION_CHECK_INTERVAL_MS = 60 * 1000;
const IS_DEV = process.env.HERALD_DEV === "1";

console.log(`Herald backend starting...`);
console.log(`  Port: ${PORT}`);
if (IS_DEV) console.log(`  Hot reload: enabled`);

// ---------------------------------------------------------------------------
// 1. Long-lived state (survives hot reloads)
// ---------------------------------------------------------------------------

const explicitProvider = process.env.HERALD_PROVIDER;
const explicitModelId = process.env.HERALD_MODEL;
const explicitModel =
  explicitProvider && explicitModelId
    ? getModel(explicitProvider as any, explicitModelId)
    : undefined;

const state: ServerState = {
  sessions: new Map<string, ManagedSession>(),
  clients: new Set<WsClient>(),
  frontendDir: new URL("../../frontend/", import.meta.url).pathname,
  explicitModel,
};

// Idle eviction — evict sessions that haven't had activity recently
// and aren't currently streaming
setInterval(() => {
  const now = Date.now();
  for (const [id, managed] of state.sessions) {
    if (managed.session.isStreaming) continue;
    if (now - managed.lastActivity > IDLE_TIMEOUT_MS) {
      state.sessions.delete(id);
      console.log(`  Session evicted (idle): ${id} (remaining: ${state.sessions.size})`);
    }
  }
}, EVICTION_CHECK_INTERVAL_MS);

// ---------------------------------------------------------------------------
// 2. Hot-reloadable handler reference
// ---------------------------------------------------------------------------

const SRC_DIR = resolve(import.meta.dirname!, ".");
const ROUTES_PATH = resolve(SRC_DIR, "routes.ts");
const WS_PATH = resolve(SRC_DIR, "ws.ts");

let routes: typeof RoutesModule;
let ws: typeof WsModule;

async function loadHandlers(): Promise<void> {
  if (IS_DEV) {
    // Cache-bust: Bun treats different query strings as distinct modules
    const t = Date.now();
    [routes, ws] = await Promise.all([
      import(`${ROUTES_PATH}?t=${t}`) as Promise<typeof RoutesModule>,
      import(`${WS_PATH}?t=${t}`) as Promise<typeof WsModule>,
    ]);
  } else {
    [routes, ws] = await Promise.all([
      import("./routes.js"),
      import("./ws.js"),
    ]);
  }
}

// ---------------------------------------------------------------------------
// 3. Dev file watcher
// ---------------------------------------------------------------------------

if (IS_DEV) {
  let debounce: ReturnType<typeof setTimeout> | null = null;

  watch(SRC_DIR, { recursive: true }, (_event, filename) => {
    if (!filename?.endsWith(".ts")) return;
    // Don't reload for state.ts changes (types only) or index.ts (this file)
    if (filename === "index.ts" || filename === "state.ts") return;

    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(async () => {
      try {
        await loadHandlers();
        console.log(`\x1b[36m[hot reload]\x1b[0m ${filename} reloaded`);
      } catch (err) {
        console.error(`\x1b[31m[hot reload]\x1b[0m Failed to reload:`, err);
      }
    }, 100);
  });
}

// ---------------------------------------------------------------------------
// 4. Start server
// ---------------------------------------------------------------------------

async function startServer(): Promise<void> {
  // Initial handler load
  await loadHandlers();

  Bun.serve({
    port: PORT,
    hostname: "0.0.0.0",

    async fetch(req, server) {
      // Always go through current handler references
      return routes.handleFetch(state, req, server) as any;
    },

    websocket: {
      open(wsConn) {
        ws.handleWsOpen(state, wsConn);
      },
      message(wsConn, message) {
        ws.handleWsMessage(state, wsConn, message);
      },
      close(wsConn) {
        ws.handleWsClose(state, wsConn);
      },
    },
  });

  console.log(`Herald backend listening on http://localhost:${PORT}`);
}

startServer().catch((err) => {
  console.error("Fatal: failed to start Herald backend:", err);
  process.exit(1);
});

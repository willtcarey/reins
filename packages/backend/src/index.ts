/**
 * Herald Backend Server (entry point)
 *
 * Owns long-lived state (sessions, clients, Bun server) and delegates
 * all request handling to handlers.ts through a mutable reference.
 *
 * In dev mode (HERALD_DEV=1), watches src/ for changes and hot-reloads
 * the handler module without restarting the process — agent sessions
 * stay alive mid-turn.
 */

import { SessionManager } from "@mariozechner/pi-coding-agent";
import { getModel } from "@mariozechner/pi-ai";
import { watch } from "fs";
import { resolve } from "path";
import type { ServerState, ManagedSession, WsClient } from "./state.js";

// We import the handler types but load via dynamic import so we can reload
import type * as HandlersModule from "./handlers.js";

const PORT = parseInt(process.env.HERALD_PORT || "3100", 10);
const PROJECT_DIR = process.env.HERALD_PROJECT_DIR || process.cwd();
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const EVICTION_CHECK_INTERVAL_MS = 60 * 1000;
const IS_DEV = process.env.HERALD_DEV === "1";

console.log(`Herald backend starting...`);
console.log(`  Project dir: ${PROJECT_DIR}`);
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
  defaultSessionId: "",
  projectDir: PROJECT_DIR,
  frontendDir: new URL("../../frontend/", import.meta.url).pathname,
  explicitModel,
};

// Idle eviction
setInterval(() => {
  const now = Date.now();
  for (const [id, managed] of state.sessions) {
    if (managed.session.isStreaming) continue;
    const hasViewers = [...state.clients].some((c) => c.activeSessionId === id);
    if (hasViewers) continue;
    if (now - managed.lastActivity > IDLE_TIMEOUT_MS) {
      state.sessions.delete(id);
      console.log(`  Session evicted (idle): ${id} (remaining: ${state.sessions.size})`);
    }
  }
}, EVICTION_CHECK_INTERVAL_MS);

// ---------------------------------------------------------------------------
// 2. Hot-reloadable handler reference
// ---------------------------------------------------------------------------

const HANDLERS_PATH = resolve(import.meta.dirname!, "handlers.ts");

let handlers: typeof HandlersModule;

async function loadHandlers(): Promise<typeof HandlersModule> {
  if (IS_DEV) {
    // Cache-bust: Bun treats different query strings as distinct modules
    return import(`${HANDLERS_PATH}?t=${Date.now()}`) as Promise<typeof HandlersModule>;
  }
  return import("./handlers.js");
}

// ---------------------------------------------------------------------------
// 3. Dev file watcher
// ---------------------------------------------------------------------------

if (IS_DEV) {
  const srcDir = resolve(import.meta.dirname!, ".");
  let debounce: ReturnType<typeof setTimeout> | null = null;

  watch(srcDir, { recursive: true }, (_event, filename) => {
    if (!filename?.endsWith(".ts")) return;
    // Don't reload for state.ts changes (types only) or index.ts (this file)
    if (filename === "index.ts" || filename === "state.ts") return;

    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(async () => {
      try {
        handlers = await loadHandlers();
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
  handlers = await loadHandlers();

  // Open the most recent session (or create a new one)
  const sessionManager = SessionManager.continueRecent(PROJECT_DIR);
  const initial = await handlers.openSession(state, sessionManager);
  state.defaultSessionId = initial.id;

  console.log(`  Model: ${initial.session.model?.provider}/${initial.session.model?.id ?? "none"}`);
  console.log(`  Thinking: ${initial.session.thinkingLevel}`);

  Bun.serve({
    port: PORT,
    hostname: "0.0.0.0",

    async fetch(req, server) {
      // Always go through current handler reference
      return handlers.handleFetch(state, req, server) as any;
    },

    websocket: {
      open(ws) {
        handlers.handleWsOpen(state, ws);
      },
      message(ws, message) {
        handlers.handleWsMessage(state, ws, message);
      },
      close(ws) {
        handlers.handleWsClose(state, ws);
      },
    },
  });

  console.log(`Herald backend listening on http://localhost:${PORT}`);
}

startServer().catch((err) => {
  console.error("Fatal: failed to start Herald backend:", err);
  process.exit(1);
});

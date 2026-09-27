/**
 * Backend Server (entry point)
 *
 * Owns long-lived state (clients, Bun server) and delegates
 * request handling to handler.ts and ws.ts through mutable references.
 *
 * In dev mode (REINS_DEV=1), watches src/ for changes and hot-reloads
 * the handler module without restarting the process (sessions run in the
 * node process and are untouched).
 */

import { watch } from "fs";
import { resolve, join } from "path";
import { mkdirSync, existsSync, readdirSync, rmSync } from "fs";
import type { ServerState, WsClient } from "./state.js";

// We import the handler types but load via dynamic import so we can reload
import type * as RoutesModule from "./handler.js";
import type * as WsModule from "./ws.js";
import { logger } from "./logger.js";
import { listenLocalNodeSocket } from "./node-transport/local-socket.js";
import { defaultLocalNodeSocketPath } from "@reins/node/protocol";

const PORT = parseInt(process.env.REINS_PORT || "3100", 10);
const IS_DEV = process.env.REINS_DEV === "1";
/** The local node socket this process listens on (restart-required); the node process dials it. */
const NODE_SOCKET = process.env.REINS_NODE_SOCKET?.trim() || defaultLocalNodeSocketPath();

logger.info(`REINS backend starting...`);
logger.info(`  Port: ${PORT}`);
if (IS_DEV) logger.info(`  Hot reload: enabled`);

// ---------------------------------------------------------------------------
// 1. Long-lived state (survives hot reloads)
// ---------------------------------------------------------------------------

const state: ServerState = {
  clients: new Set<WsClient>(),
  frontendDir: new URL("../../frontend/", import.meta.url).pathname,
};

// ---------------------------------------------------------------------------
// 2. Hot-reloadable handler reference
// ---------------------------------------------------------------------------

const SRC_DIR = resolve(import.meta.dirname!, ".");
const SERVER_ENTRY_PATH = resolve(SRC_DIR, "server.ts");

let routes: typeof RoutesModule;
let ws: typeof WsModule;
let uninstallRuntimeHooks: (() => void) | null = null;

/**
 * Dev build output directory — placed under packages/backend/ so that
 * bare-specifier imports (e.g. @earendil-works/pi-coding-agent) resolve
 * against the workspace's node_modules via Bun's module resolution.
 */
const DEV_BUILD_ROOT = resolve(SRC_DIR, "../.dev-build");
/** Per process, so dev servers running from one checkout (e.g. under process-level tests) never import
 * each other's half-written bundles. */
const DEV_BUILD_DIR = join(DEV_BUILD_ROOT, String(process.pid));

// Install the current handler module's runtime hooks and replace the previous cleanup.
function installRoutes(): void {
  const nextUninstall = routes.install(state);
  uninstallRuntimeHooks?.();
  uninstallRuntimeHooks = nextUninstall;
}

async function loadHandlers(): Promise<void> {
  if (IS_DEV) {
    // Bundle handler.ts and ws.ts (with all transitive src/ deps) into temp
    // files. Node_modules stay external (cached by Bun's module system).
    // This ensures ANY source file change is picked up on reload.
    if (!existsSync(DEV_BUILD_DIR)) mkdirSync(DEV_BUILD_DIR, { recursive: true });

    const result = await Bun.build({
      entrypoints: [SERVER_ENTRY_PATH],
      outdir: DEV_BUILD_DIR,
      target: "bun",
      format: "esm",
      packages: "external",
    });

    if (!result.success) {
      const msgs = result.logs.map((l) => l.message ?? String(l)).join("\n");
      throw new Error(`Dev build failed:\n${msgs}`);
    }

    // Cache-bust the bundled output so Bun imports the fresh version
    const t = Date.now();
    const mod = await import(`${join(DEV_BUILD_DIR, "server.js")}?t=${t}`);
    routes = mod.routes;
    ws = mod.ws;
  } else {
    [routes, ws] = await Promise.all([
      import("./handler.js"),
      import("./ws.js"),
    ]);
  }
}

// ---------------------------------------------------------------------------
// 3. Dev file watcher
// ---------------------------------------------------------------------------

if (IS_DEV) {
  removeStaleDevBuilds();
  process.on("exit", () => rmSync(DEV_BUILD_DIR, { recursive: true, force: true }));
  let debounce: ReturnType<typeof setTimeout> | null = null;
  const reload = (what: string) => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(async () => {
      try {
        await loadHandlers();
        installRoutes();
        logger.info(`\x1b[36m[hot reload]\x1b[0m ${what}`);
      } catch (err) {
        logger.error(`\x1b[31m[hot reload]\x1b[0m Failed to reload:`, err);
      }
    }, 100);
  };

  watch(SRC_DIR, { recursive: true }, (_event, filename) => {
    if (!filename?.endsWith(".ts")) return;
    // Bootstrap and process-owner modules require a full process restart.
    if (["index.ts", "server-process.ts", "state.ts"].includes(filename)) return;
    reload(`${filename} reloaded`);
  });
  // The same reload without a source change (`kill -USR2 <pid>`; process-level tests).
  process.on("SIGUSR2", () => reload("reloaded on SIGUSR2"));
}

/** Build directories of dev servers that are no longer running. */
function removeStaleDevBuilds(): void {
  if (!existsSync(DEV_BUILD_ROOT)) return;
  for (const entry of readdirSync(DEV_BUILD_ROOT)) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    try { process.kill(Number(entry), 0); continue; } catch { /* not running */ }
    rmSync(join(DEV_BUILD_ROOT, entry), { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 4. Start server
// ---------------------------------------------------------------------------

/**
 * The internal node runs in its own process (`packages/node/src/main.ts`) and dials this listener. The
 * listener belongs to this process owner, not to a handler, so it survives handler hot reload; every
 * connection is routed to the handler installed when it arrives. This process never starts a node or
 * opens node storage.
 */
async function startLocalNodeListener(): Promise<void> {
  const listener = await listenLocalNodeSocket(NODE_SOCKET, socket => routes.acceptNodeConnection(state, socket));
  process.on("exit", () => listener.stop());
  // Exit through "exit" so the socket file is removed; a signal's default action would skip it.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      logger.info(`Received ${signal}; shutting down`);
      process.exit(0);
    });
  }
  logger.info(`  Node socket: ${listener.path}`);
}

async function startServer(): Promise<void> {
  // Initial handler load
  await loadHandlers();
  installRoutes();
  await startLocalNodeListener();

  const httpServer = Bun.serve({
    port: PORT,
    hostname: "0.0.0.0",
    maxRequestBodySize: 1024 * 1024 * 512, // 512 MB

    async fetch(req, server) {
      // Always go through current handler references
      const response = await routes.handleFetch(state, req, server);
      return response ?? new Response("Not Found", { status: 404 });
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

  logger.info(`REINS backend listening on http://localhost:${httpServer.port}`);
}

startServer().catch((err) => {
  logger.error("Fatal: failed to start REINS backend:", err);
  process.exit(1);
});

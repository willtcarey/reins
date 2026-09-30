/**
 * Backend Server (entry point)
 *
 * Owns long-lived state (clients, Bun server) and delegates
 * request handling to handler.ts and ws.ts through mutable references.
 *
 * In dev mode (REINS_DEV=1), product handlers and telemetry hot reload without replacing node links.
 * The hub/dispatcher and protocol are process-owned; edits log restart-required warnings. Pi runs on
 * the node and is untouched by an HTTP-handler reload.
 *
 * The database is process state too: it is opened here once (migrations and outbox recovery run at
 * process startup only). Handler bundles use the same external `db.ts` and handle; product reloads
 * never open a second connection or re-run startup recovery.
 */

import { watch } from "fs";
import { resolve, join } from "path";
import { mkdirSync, existsSync, readdirSync, rmSync } from "fs";
import type { ServerState, WsClient } from "./state.js";
import { createNodeHub } from "./runtimes/node-hub.js";
import type { NodeHubServices } from "./runtimes/node-hub.js";

// We import the handler types but load via dynamic import so we can reload
import type * as ServerModule from "./server.js";
import { openDb, setDb } from "./db.js";
import { logger } from "./logger.js";
import { buildDevBundle, RESTART_REQUIRED_SOURCES } from "./dev-build.js";
import { listenLocalNodeSocket } from "./node-transport/local-socket.js";
import { defaultLocalNodeSocketPath } from "@reins/node-protocol";

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

const db = openDb();
setDb(db);
let services: NodeHubServices;
const clients = new Set<WsClient>();
const state: ServerState = {
  clients,
  frontendDir: new URL("../../frontend/", import.meta.url).pathname,
  nodes: createNodeHub(clients, () => services),
};

// ---------------------------------------------------------------------------
// 2. Hot-reloadable handler reference
// ---------------------------------------------------------------------------

const SRC_DIR = resolve(import.meta.dirname!, ".");
const SERVER_ENTRY_PATH = resolve(SRC_DIR, "server.ts");
/** Shared sources: telemetry reloads with product handlers; protocol changes require coordinated restart. */
const SHARED_SRC_DIRS = ["node-protocol", "telemetry"].map(name => ({ name: `@reins/${name}`, dir: resolve(SRC_DIR, `../../${name}/src`) }));

let routes: typeof ServerModule.routes;
let ws: typeof ServerModule.ws;

/**
 * Dev build output directory — placed under packages/backend/ so that
 * bare-specifier imports (e.g. @earendil-works/pi-coding-agent) resolve
 * against the workspace's node_modules via Bun's module resolution.
 */
const DEV_BUILD_ROOT = resolve(SRC_DIR, "../.dev-build");
/** Per process, so dev servers running from one checkout (e.g. under process-level tests) never import
 * each other's half-written bundles. */
const DEV_BUILD_DIR = join(DEV_BUILD_ROOT, String(process.pid));

async function loadHandlers(): Promise<void> {
  const mod = await importHandlers();
  mod.setDb(db);
  const nextServices = mod.nodeServerServices(state);
  routes = mod.routes;
  ws = mod.ws;
  services = nextServices;
}

async function importHandlers(): Promise<typeof ServerModule> {
  if (IS_DEV) {
    // Product sources reload; node-protocol and third-party dependencies keep their process-lifetime
    // identity. The watcher treats process-owned source changes as restart-required.
    if (!existsSync(DEV_BUILD_DIR)) mkdirSync(DEV_BUILD_DIR, { recursive: true });
    await buildDevBundle(SERVER_ENTRY_PATH, DEV_BUILD_DIR);

    // Cache-bust the bundled output so Bun imports the fresh version
    const t = Date.now();
    return import(`${join(DEV_BUILD_DIR, "server.js")}?t=${t}`);
  }
  return import("./server.js");
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
        logger.info(`\x1b[36m[hot reload]\x1b[0m ${what}`);
      } catch (err) {
        logger.error(`\x1b[31m[hot reload]\x1b[0m Failed to reload:`, err);
      }
    }, 100);
  };

  watch(SRC_DIR, { recursive: true }, (_event, filename) => {
    if (!filename?.endsWith(".ts") || filename.endsWith(".test.ts") || /(^|\/)__\w+__\//.test(filename)) return;
    if (RESTART_REQUIRED_SOURCES.has(filename)) {
      logger.warn(`${filename}: process-owned code changed; restart the server to apply it`);
      return;
    }
    if (filename === "migrations.ts" || filename.startsWith("migrations/")) {
      logger.warn(`\x1b[33m[hot reload]\x1b[0m ${filename}: migrations run at process startup only; restart the server to apply them`);
      return;
    }
    reload(`${filename} reloaded`);
  });
  for (const { name, dir } of SHARED_SRC_DIRS) {
    watch(dir, { recursive: true }, (_event, filename) => {
      if (!filename?.endsWith(".ts") || filename.endsWith(".test.ts") || /(^|\/)__\w+__\//.test(filename)) return;
      if (name === "@reins/node-protocol") {
        logger.warn(`${name} ${filename}: protocol code changed; restart the server and node together`);
        return;
      }
      reload(`${name} ${filename} reloaded`);
    });
  }
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
 * The local node runs in its own process (`packages/node/src/main.ts`) and dials this listener. The
 * listener and hub belong to this process owner and survive HTTP-handler reloads. Each call uses the
 * current product services. This process never starts a node.
 */
async function startLocalNodeListener(): Promise<void> {
  const listener = await listenLocalNodeSocket(NODE_SOCKET, socket => state.nodes.accept(socket));
  process.on("exit", () => { state.nodes.close(); listener.stop(); });
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
  state.nodes.start();
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

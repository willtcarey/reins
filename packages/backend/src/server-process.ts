/**
 * Backend Server (entry point)
 *
 * Owns what lives as long as the process: the browser clients and the HTTP server. Everything else is
 * the handler module (`server.ts`), which this process starts and stops as a whole: the database, routes,
 * WS handlers, the node hub and the node socket listener.
 *
 * In dev mode (REINS_DEV=1), source changes rebuild the handler module, stop the running load and start
 * the new one. Stopping closes the node's connection and the node redials the new listener; work in flight
 * recovers through the link's resend and link-loss paths (docs/dev/hot-reload.md). Pi runs on the node and
 * is untouched.
 */

import { watch } from "fs";
import { resolve, join } from "path";
import { mkdirSync, existsSync, readdirSync, rmSync } from "fs";
import type { WsClient } from "./state.js";

// We import the handler types but load via dynamic import so we can reload
import type * as ServerModule from "./server.js";
import { logger } from "./logger.js";
import { buildDevBundle } from "./dev-build.js";
import { defaultLocalNodeSocketPath } from "@reins/node-protocol";

const PORT = parseInt(process.env.REINS_PORT || "3100", 10);
const IS_DEV = process.env.REINS_DEV === "1";
/** The local node socket each handler load listens on; the node process dials it. */
const NODE_SOCKET = process.env.REINS_NODE_SOCKET?.trim() || defaultLocalNodeSocketPath();

logger.info(`REINS backend starting...`);
logger.info(`  Port: ${PORT}`);
if (IS_DEV) logger.info(`  Hot reload: enabled`);

// ---------------------------------------------------------------------------
// 1. Process state (survives hot reloads)
// ---------------------------------------------------------------------------

const clients = new Set<WsClient>();
const FRONTEND_DIR = new URL("../../frontend/", import.meta.url).pathname;

// ---------------------------------------------------------------------------
// 2. Hot-reloadable handler reference
// ---------------------------------------------------------------------------

const SRC_DIR = resolve(import.meta.dirname!, ".");
const SERVER_ENTRY_PATH = resolve(SRC_DIR, "server.ts");
/** Shared sources: telemetry reloads with product handlers; protocol changes require coordinated restart. */
const SHARED_SRC_DIRS = ["node-protocol", "telemetry"].map(name => ({ name: `@reins/${name}`, dir: resolve(SRC_DIR, `../../${name}/src`) }));

/** The handler load serving now. */
let running: ServerModule.RunningServer | undefined;

/**
 * Dev build output directory — placed under packages/backend/ so that
 * bare-specifier imports (e.g. @earendil-works/pi-coding-agent) resolve
 * against the workspace's node_modules via Bun's module resolution.
 */
const DEV_BUILD_ROOT = resolve(SRC_DIR, "../.dev-build");
/** Per process, so dev servers running from one checkout (e.g. under process-level tests) never import
 * each other's half-written bundles. */
const DEV_BUILD_DIR = join(DEV_BUILD_ROOT, String(process.pid));

/**
 * Loads the handler module, stops the running load and starts the new one. Stopping drops the node's
 * connection: calls in flight on it end with outcome unknown (outbox commands requeue, the node resends
 * its commits and reports) and the node redials the new load. The new load starts only once the old one
 * has settled its deliveries and closed its database. A build or import failure leaves the running load
 * untouched; if the new load fails to start, nothing serves until the next reload.
 */
async function loadHandlers(): Promise<void> {
  const mod = await importHandlers();
  const previous = running;
  running = undefined;
  await previous?.stop();
  running = await mod.start({ clients, frontendDir: FRONTEND_DIR, nodeSocket: NODE_SOCKET });
}

async function importHandlers(): Promise<typeof ServerModule> {
  if (IS_DEV) {
    // Every local source reloads, node hub included; node-protocol and third-party dependencies keep
    // their process-lifetime identity (`dev-build.ts`).
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

/** Sources a reload cannot apply: the process owner itself. */
const PROCESS_OWNER_SOURCES = new Set(["index.ts", "server-process.ts", "dev-build.ts"]);

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
    if (PROCESS_OWNER_SOURCES.has(filename)) {
      logger.warn(`\x1b[33m[hot reload]\x1b[0m ${filename}: the process owner changed; restart the server to apply it`);
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
 * The local node runs in its own process (`packages/node/src/main.ts`) and dials the current load's
 * listener. This process never starts a node.
 */
async function startServer(): Promise<void> {
  // Initial handler load
  await loadHandlers();
  // Exit handlers run synchronously: `stop` closes the node links and listener (removing the socket file)
  // before its first await.
  process.on("exit", () => void running?.stop());
  // Exit through "exit" so the socket file is removed; a signal's default action would skip it.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      logger.info(`Received ${signal}; shutting down`);
      process.exit(0);
    });
  }
  logger.info(`  Node socket: ${NODE_SOCKET}`);

  const httpServer = Bun.serve({
    port: PORT,
    hostname: "0.0.0.0",
    maxRequestBodySize: 1024 * 1024 * 512, // 512 MB

    async fetch(req, server) {
      // Always go through the running handler load; none while a reload switches loads.
      if (!running) return new Response("Server reloading", { status: 503 });
      const response = await running.fetch(req, server);
      return response ?? new Response("Not Found", { status: 404 });
    },

    // Browser sockets belong to the process, so they keep working across reloads; each message goes to the
    // running load.
    websocket: {
      open(wsConn) {
        clients.add({ ws: wsConn });
        logger.info(`WebSocket client connected (total: ${clients.size})`);
      },
      message(wsConn, message) {
        if (running) running.message(wsConn, message);
        else wsConn.send(JSON.stringify({ type: "error", error: "Server reloading; try again" }));
      },
      close(wsConn) {
        for (const client of clients) if (client.ws === wsConn) clients.delete(client);
        logger.info(`WebSocket client disconnected (total: ${clients.size})`);
      },
    },
  });

  logger.info(`REINS backend listening on http://localhost:${httpServer.port}`);
}

startServer().catch((err) => {
  logger.error("Fatal: failed to start REINS backend:", err);
  process.exit(1);
});

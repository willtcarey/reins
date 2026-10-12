/**
 * Backend Server (entry point)
 *
 * The process: owns what lives as long as it does (`ServerProcess`, ADR-029): the HTTP server, the
 * browser connections, the database connection, the sessions it keeps running across apps (live
 * runtimes, which an app fills and this process's idle sweep empties), the credential store's lock and
 * the current app (`process-state.ts`). Everything else is the app (`server.ts`), which this process
 * starts and stops as a whole: routes, WS handlers, the node hub, the node socket listener and the remote
 * nodes' WebSocket links (a socket whose upgrade data carries handlers is driven by them, so it belongs to
 * the app that upgraded it).
 *
 * In dev mode (REINS_DEV=1), source changes rebuild the app, stop the running one and start the new one.
 * Stopping closes the node's connection and the node redials the new listener; tool calls in flight ride
 * through (docs/dev/hot-reload.md). A session runtime keeps running on the code it was built with,
 * reaching the new app through `ServerProcess.app`.
 *
 * The first app resumes the runs the previous process left running; on SIGTERM or SIGINT this process
 * pauses its runs at their pause points (bounded) and suspends them for the next one (`suspendSessions`).
 */

import { watch } from "fs";
import { resolve, join } from "path";
import { mkdirSync, existsSync, readdirSync, rmSync } from "fs";
import type { UpgradeData, WsClient } from "./state.js";
import { openDatabase } from "./database.js";
import { createServerProcess, IDLE_SWEEP_INTERVAL_MS, suspendSessions } from "./process-state.js";

// We import the app's types but load it via dynamic import so we can reload
import type * as ServerModule from "./server.js";
import { logger } from "./logger.js";
import { buildDevBundle } from "./dev-build.js";
import { defaultLocalNodeSocketPath, REMOTE_MAX_FRAME_BYTES } from "@reins/node-protocol";

const PORT = parseInt(process.env.REINS_PORT || "3100", 10);
const IS_DEV = process.env.REINS_DEV === "1";
/** The local node socket each app listens on; the node process dials it. */
const NODE_SOCKET = process.env.REINS_NODE_SOCKET?.trim() || defaultLocalNodeSocketPath();

logger.info(`REINS backend starting...`);
logger.info(`  Port: ${PORT}`);
if (IS_DEV) logger.info(`  Hot reload: enabled`);

// ---------------------------------------------------------------------------
// 1. Process state (survives hot reloads)
// ---------------------------------------------------------------------------

/** Browser connections: registered here as they open and close, so they outlive apps. */
const clients = new Set<WsClient>();
const serverProcess = createServerProcess({
  /** Opened once; every app migrates it (a new migration applies on the next reload) and none closes it. */
  db: openDatabase(),
  broadcast(frame) {
    for (const client of clients) {
      try { client.ws.send(frame); } catch { /* a closing socket */ }
    }
  },
  frontendDir: new URL("../../frontend/", import.meta.url).pathname,
  nodeSocket: NODE_SOCKET,
});
// Live session runtimes are kept across apps; idle ones are closed here.
setInterval(() => serverProcess.sessions.sweep(), IDLE_SWEEP_INTERVAL_MS).unref();
/** Types the data of the sockets the HTTP server upgrades (Bun reads only its type). */
const UPGRADE_DATA: UpgradeData = {};

// ---------------------------------------------------------------------------
// 2. The hot-reloadable app
// ---------------------------------------------------------------------------

const SRC_DIR = resolve(import.meta.dirname!, ".");
const SERVER_ENTRY_PATH = resolve(SRC_DIR, "server.ts");
/** Shared sources: telemetry reloads with the app; protocol changes require coordinated restart. */
const SHARED_SRC_DIRS = ["node-protocol", "telemetry"].map(name => ({ name: `@reins/${name}`, dir: resolve(SRC_DIR, `../../${name}/src`) }));

/** The running app. */
let running: ServerModule.RunningApp | undefined;

/**
 * Dev build output directory — placed under packages/backend/ so that
 * bare-specifier imports (e.g. @earendil-works/pi-coding-agent) resolve
 * against the workspace's node_modules via Bun's module resolution.
 */
const DEV_BUILD_ROOT = resolve(SRC_DIR, "../.dev-build");
/** Per process, so dev servers running from one checkout (e.g. under process-level tests) never import
 * each other's half-written bundles. */
const DEV_BUILD_DIR = join(DEV_BUILD_ROOT, String(process.pid));

/** Whether an app has started: only the first resumes the runs a previous process left running. */
let started = false;

/**
 * Loads the app, stops the running one and starts the new one. Stopping drops the node's connection:
 * calls in flight on it end with outcome unknown (a session's tool calls send them again or pick their
 * command up on the new link) and the node redials the new app. Session runtimes keep running meanwhile:
 * their calls on an app wait for the new one (`ServerProcess.app`), which closes the idle ones built by
 * older code as it registers. A build or import failure leaves the running app untouched; if the new app
 * fails to start, nothing serves until the next reload.
 */
async function loadApp(): Promise<void> {
  const mod = await importApp();
  const previous = running;
  running = undefined;
  await previous?.stop();
  running = await mod.start(serverProcess, { recoverRuns: !started });
  started = true;
}

async function importApp(): Promise<typeof ServerModule> {
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
const PROCESS_OWNER_SOURCES = new Set(["index.ts", "server-process.ts", "dev-build.ts", "process-state.ts", "database.ts"]);

if (IS_DEV) {
  removeStaleDevBuilds();
  process.on("exit", () => rmSync(DEV_BUILD_DIR, { recursive: true, force: true }));
  let debounce: ReturnType<typeof setTimeout> | null = null;
  const reload = (what: string) => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(async () => {
      try {
        await loadApp();
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
 * The local node runs in its own process (`packages/node/src/main.ts`) and dials the current app's
 * listener. This process never starts a node.
 */
async function startServer(): Promise<void> {
  // The first app
  await loadApp();
  // Exit handlers run synchronously: `stop` closes the node links and listener (removing the socket file)
  // before its first await.
  process.on("exit", () => void running?.stop());
  // Runs are paused at their pause points and suspended, for the next process to resume. Exit through
  // "exit" so the socket file is removed; a signal's default action would skip it.
  let stopping = false;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      logger.info(`Received ${signal}; shutting down`);
      suspendSessions(serverProcess.sessions)
        .catch((error: unknown) => logger.error("Suspending sessions failed:", error))
        .finally(() => process.exit(0));
    });
  }
  logger.info(`  Node socket: ${NODE_SOCKET}`);

  const httpServer = Bun.serve({
    port: PORT,
    hostname: "0.0.0.0",
    maxRequestBodySize: 1024 * 1024 * 512, // 512 MB

    async fetch(req, server) {
      // Always go through the running app; none while a reload switches apps.
      if (!running) return new Response("Server reloading", { status: 503 });
      const response = await running.fetch(req, server);
      return response ?? new Response("Not Found", { status: 404 });
    },

    // A socket an app upgraded with its own handlers (a remote node's `/nodes/link`) is driven by them: it
    // is that app's, and its logic reloads with it. Browser sockets (`/ws`, no handlers) belong to the
    // process, so they keep working across reloads; each message goes to the running app.
    websocket: {
      data: UPGRADE_DATA,
      // The remote node link's frame cap (inbound messages over it close the socket); browser messages
      // are far smaller.
      maxPayloadLength: REMOTE_MAX_FRAME_BYTES,
      open(wsConn) {
        if (wsConn.data.handlers) { wsConn.data.handlers.open(wsConn); return; }
        clients.add({ ws: wsConn });
        logger.info(`WebSocket client connected (total: ${clients.size})`);
      },
      message(wsConn, message) {
        if (wsConn.data.handlers) { wsConn.data.handlers.message(wsConn, message); return; }
        if (running) running.message(wsConn, message);
        else wsConn.send(JSON.stringify({ type: "error", error: "Server reloading; try again" }));
      },
      drain(wsConn) {
        wsConn.data.handlers?.drain(wsConn);
      },
      close(wsConn, code, reason) {
        if (wsConn.data.handlers) { wsConn.data.handlers.close(wsConn, code, reason); return; }
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

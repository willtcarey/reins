/**
 * Backend Server (entry point)
 *
 * The process: owns what lives as long as it does (`ServerProcess`, ADR-029): the HTTP server, the
 * browser connections, the database connection, the sessions it keeps running across apps (live
 * runtimes, which an app fills and this process's idle sweep empties), the credential store's locks and
 * the current app (`process-state.ts`). Everything else is the app (`server.ts`), which this process
 * starts and stops as a whole: routes, WS handlers, models, the node hub, the node socket listener, the
 * remote nodes' WebSocket links (a socket whose upgrade data carries handlers is driven by them, so it
 * belongs to the app that upgraded it) and the node bundle. The process-owned sources
 * (`process-owned.json`) import only each other, the protocol and packages: a change to them needs a
 * restart.
 *
 * In dev mode (REINS_DEV=1), source changes rebuild the app, stop the running one and start the new one.
 * Stopping closes the nodes' connections and they redial the new app; a bash command in flight picks its
 * output up again on the new link (docs/dev/hot-reload.md). A session runtime keeps running on the code it
 * was built with, reaching the new app through `ServerProcess.app`.
 *
 * The first app resumes the runs the previous process left running; on SIGTERM or SIGINT this process
 * pauses its runs at their pause points (bounded) and suspends them for the next one (`suspendSessions`).
 * Under the supervisor (`REINS_SERVER_RESTART_EXIT_CODE`) it does the same and exits with that code to be
 * restarted alone, the node running on: on SIGHUP, and in dev on a process-owned edit (`dev-watch.ts`),
 * each once its new code builds.
 */

import { resolve, join } from "path";
import { mkdirSync, existsSync, readdirSync, rmSync } from "fs";
import type { UpgradeData, WsClient } from "./state.js";
import { openDatabase } from "./database.js";
import { createServerProcess, IDLE_SWEEP_INTERVAL_MS, suspendSessions } from "./process-state.js";
import processOwnedSources from "./process-owned.json" with { type: "json" };

// We import the app's types but load it via dynamic import so we can reload
import type * as ServerModule from "./server.js";
import { logger } from "./logger.js";
import { buildDevBundle, checkBuilds } from "./dev-build.js";
import { watchDevSources } from "./dev-watch.js";
import { defaultLocalNodeSocketPath, REMOTE_MAX_FRAME_BYTES } from "@reins/node-protocol";

const PORT = parseInt(process.env.REINS_PORT || "3100", 10);
const IS_DEV = process.env.REINS_DEV === "1";
/** The exit code the supervisor restarts this process alone on; unset when nothing would. */
const RESTART_EXIT_CODE = process.env.REINS_SERVER_RESTART_EXIT_CODE ? Number(process.env.REINS_SERVER_RESTART_EXIT_CODE) : undefined;
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
/** This process's entry, built to check its code before a restart. */
const PROCESS_ENTRY_PATH = resolve(SRC_DIR, "index.ts");
/** Telemetry reloads with the app; protocol changes require the server and node restarted together. */
const TELEMETRY_SRC = { name: "@reins/telemetry", dir: resolve(SRC_DIR, "../../telemetry/src") };
const PROTOCOL_SRC = { name: "@reins/node-protocol", dir: resolve(SRC_DIR, "../../node-protocol/src") };

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
 * Loads the app, stops the running one and starts the new one. Stopping drops the nodes' connections:
 * calls in flight on them end with outcome unknown (a session's tool calls send them again or pick their
 * command up on the new link) and the nodes redial the new app. Session runtimes keep running meanwhile:
 * during the gap their node calls wait, their Reins tool calls are not run and their run reports are
 * queued for the new app (`ServerProcess.app`), which closes the idle runtimes built by older code as it
 * registers. A build or import failure leaves the running app untouched; if the new app fails to start,
 * nothing serves until the next reload.
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
    // Every local source the app reaches reloads, node hub included; node-protocol and third-party
    // dependencies keep their process-lifetime identity (`dev-build.ts`).
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

/** Sources a reload cannot apply: the process-owned ones (`process-owned.json`, relative to `src/`; the
 * lint rule `reins/process-owned-imports` reads the same list), and the list itself. */
const PROCESS_OWNER_SOURCES = new Set<string>([...processOwnedSources, "process-owned.json"]);

if (IS_DEV) {
  removeStaleDevBuilds();
  process.on("exit", () => rmSync(DEV_BUILD_DIR, { recursive: true, force: true }));
  const watcher = watchDevSources({
    srcDir: SRC_DIR,
    processOwned: PROCESS_OWNER_SOURCES,
    processEntry: PROCESS_ENTRY_PATH,
    packages: [TELEMETRY_SRC],
    protocol: PROTOCOL_SRC,
    reload: loadApp,
    restart: RESTART_EXIT_CODE === undefined ? undefined : what => exitProcess(`Restarting: ${what}`, RESTART_EXIT_CODE),
  });
  // The same reload without a source change (`kill -USR2 <pid>`; process-level tests).
  process.on("SIGUSR2", () => watcher.reload("reloaded on SIGUSR2"));
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
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => exitProcess(`Received ${signal}; shutting down`, 0));
  }
  // A restart by hand (`kill -HUP <server pid>`), as a process-owned edit triggers one in dev.
  if (RESTART_EXIT_CODE !== undefined) {
    const code = RESTART_EXIT_CODE;
    process.on("SIGHUP", () => {
      checkBuilds(PROCESS_ENTRY_PATH).then(
        () => exitProcess("Received SIGHUP; restarting", code),
        (error: unknown) => logger.error("Received SIGHUP, but the server's code does not build; it keeps running:", error),
      );
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

let stopping = false;

/** Pauses the runs at their pause points and suspends them, for the next process to resume, then exits
 * with `code`: 0 to stop, `RESTART_EXIT_CODE` for the supervisor to start this process again. Exits through
 * "exit" so the socket file is removed; a signal's default action would skip it. */
function exitProcess(reason: string, code: number): void {
  if (stopping) return;
  stopping = true;
  logger.info(reason);
  suspendSessions(serverProcess.sessions)
    .catch((error: unknown) => logger.error("Suspending sessions failed:", error))
    .finally(() => process.exit(code));
}

startServer().catch((err) => {
  logger.error("Fatal: failed to start REINS backend:", err);
  process.exit(1);
});

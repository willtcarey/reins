/**
 * Node-only executable: a node in its own process.
 *
 * Opens only node storage (`~/.reins/node/storage.db`), starts the node and dials the server's local
 * socket (`REINS_NODE_SOCKET`, default `~/.reins/run/node.sock`), redialing with backoff whenever the
 * server is absent or the connection drops, so it may start before the server. It never imports server
 * code or opens the server database (Oxlint `reins/node-implementation-isolation`).
 *
 * SIGTERM/SIGINT: stop redialing and close the connection (no new commands), abort active runs and close
 * their runtimes (each run settles durably into the outbox, bounded by SHUTDOWN_TIMEOUT_MS), close the
 * node database and exit 0. See node-contract.md *Process model*.
 *
 * Dev reload (`REINS_NODE_DEV_RELOAD=1`, set by `supervisor.ts dev` only): after a node source change
 * (or SIGUSR2), waits until no run or command is active, stops the same way and exits with
 * `NODE_RELOAD_EXIT_CODE` so the supervisor restarts it on the new code (see `dev-reload.ts`).
 */
import { connectLocalNode, DEFAULT_LOCAL_NODE_ID } from "./local-link.js";
import { startNode } from "./node.js";
import { nodeStoragePath, openNodeDb } from "./storage.js";
import { defaultLocalNodeSocketPath } from "./protocol/local-link.js";
import { createReloadWhenIdle, NODE_RELOAD_EXIT_CODE, trackCalls, watchSources } from "./dev-reload.js";
import { nodeActivity } from "./node.js";

/** A run that does not finish aborting in time is cut off, as by a crash. */
const SHUTDOWN_TIMEOUT_MS = 5_000;

const log = (message: string) => console.log(`[node] ${message}`);
const socketPath = process.env.REINS_NODE_SOCKET?.trim() || defaultLocalNodeSocketPath();
/** The node this process is: the server serves the connection only if it has a node with this ID. */
const nodeId = process.env.REINS_NODE_ID?.trim() || DEFAULT_LOCAL_NODE_ID;
const devReload = process.env.REINS_NODE_DEV_RELOAD === "1";

// TEST HOOK ONLY (see testing/faux-provider.ts): lets process-level tests drive a scripted model.
const testFauxProvider = process.env.REINS_NODE_TEST_FAUX_PROVIDER?.trim();
if (testFauxProvider) {
  const { registerTestFauxProvider } = await import("./testing/faux-provider.js");
  registerTestFauxProvider(testFauxProvider);
  log(`TEST: registered faux provider ${testFauxProvider}`);
}

const storagePath = nodeStoragePath();
const db = openNodeDb(storagePath);
log(`storage: ${storagePath}`);
const node = startNode(db);
// Dev only: commands are counted so a reload waits for them too.
const commands = devReload ? trackCalls(node, ["attach", "shutdown"]) : undefined;
const client = connectLocalNode(commands?.tracked ?? node, {
  path: socketPath,
  nodeId,
  onStatus: status => log(status === "connected" ? `connected to server at ${socketPath}` : "disconnected from server; redialing"),
});
log(`dialing server at ${socketPath} as node ${nodeId}`);

let stopDevReload: (() => void) | undefined;
if (commands) {
  const reloader = createReloadWhenIdle({
    activity: () => {
      const { activeRuns, pendingWork } = nodeActivity(node);
      return { activeRuns, pending: pendingWork + commands.inFlight() };
    },
    reload: () => void shutdown("reloading", NODE_RELOAD_EXIT_CODE),
    log,
  });
  // REINS_NODE_DEV_WATCH_DIR: process-level tests watch a scratch directory instead of the checkout.
  const watchDir = process.env.REINS_NODE_DEV_WATCH_DIR?.trim() || import.meta.dirname;
  const unwatch = watchSources(watchDir, filename => reloader.changed(filename));
  // The same reload without a source change (`kill -USR2 <node pid>`).
  process.on("SIGUSR2", () => reloader.changed("SIGUSR2"));
  stopDevReload = () => { unwatch(); reloader.stop(); };
  log(`dev reload: watching ${watchDir}; restarts when idle after a change`);
}

let stopping = false;
async function shutdown(reason: string, exitCode = 0): Promise<void> {
  if (stopping) return;
  stopping = true;
  stopDevReload?.();
  log(`${reason}; stopping`);
  client.stop();
  const timeout = new Promise<"timeout">(resolve => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS, "timeout").unref());
  if (await Promise.race([node.shutdown().then(() => "done" as const), timeout]) === "timeout") {
    console.error(`[node] active runs did not stop within ${SHUTDOWN_TIMEOUT_MS}ms; exiting anyway`);
  }
  db.close();
  log(exitCode === NODE_RELOAD_EXIT_CODE ? "stopped for reload" : "stopped");
  process.exit(exitCode);
}
process.on("SIGTERM", () => void shutdown("received SIGTERM"));
process.on("SIGINT", () => void shutdown("received SIGINT"));

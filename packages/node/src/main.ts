/**
 * Node-only executable: a node in its own process.
 *
 * Holds no session state on disk (ADR-015; its data directory, `REINS_NODE_DATA_DIR` or `~/.reins`, holds
 * only unfinished file writes): starts the node and dials the server's local socket
 * (`REINS_NODE_SOCKET`, default `~/.reins/run/node.sock`), redialing with backoff whenever the server is
 * absent or the connection drops, so it may start before the server. It never imports server code or
 * opens the server database (Oxlint `reins/node-implementation-isolation`).
 *
 * SIGTERM/SIGINT: hold every run at its next pause point (bounded by SHUTDOWN_PAUSE_MS, then whatever is
 * still in flight is cut off), stop redialing and close the connection, close every runtime without
 * aborting its run (bounded by SHUTDOWN_TIMEOUT_MS) and exit 0. The server resumes the runs when a node
 * next connects (ADR-021). See node-contract.md *Process model*.
 *
 * Nothing reloads this process on a code change. Under the supervisor (`REINS_NODE_RELOAD_EXIT_CODE`) it
 * serves `node.reload`: once its runs are paused it stops the same way and exits with that code, and the
 * supervisor starts it again at once on its new code (see docs/dev/hot-reload.md).
 *
 * A server that refuses this node (`NODE_REFUSED`: an unknown or revoked node) is not redialed: the node
 * stops as on SIGTERM and exits with `REINS_NODE_REFUSED_EXIT_CODE` (1 without it), which the supervisor
 * does not restart.
 */
import { connectLocalNode, DEFAULT_LOCAL_NODE_ID } from "./local-link.js";
import { startNode, type NodeReloader } from "./node.js";
import { nodeHome } from "./node-home.js";
import { defaultLocalNodeSocketPath } from "@reins/node-protocol";

/** How long SIGTERM waits for runs to reach a pause point before cutting off what is still in flight. */
const SHUTDOWN_PAUSE_MS = 3_000;
/** Closing runtimes that does not finish in time is cut short, as by a crash. */
const SHUTDOWN_TIMEOUT_MS = 5_000;

const log = (message: string) => console.log(`[node] ${message}`);
const socketPath = process.env.REINS_NODE_SOCKET?.trim() || defaultLocalNodeSocketPath();
/** The node this process is: the server serves the connection only if it has a node with this ID. */
const nodeId = process.env.REINS_NODE_ID?.trim() || DEFAULT_LOCAL_NODE_ID;
/** The node's own files (none durable: unfinished `fs.write`s), beside its socket by default. */
const dataDir = nodeHome();

// TEST HOOK ONLY (see testing/faux-provider.ts): lets process-level tests drive a scripted model.
const testFauxProvider = process.env.REINS_NODE_TEST_FAUX_PROVIDER?.trim();
if (testFauxProvider) {
  const { registerTestFauxProvider } = await import("./testing/faux-provider.js");
  registerTestFauxProvider(testFauxProvider);
  log(`TEST: registered faux provider ${testFauxProvider}`);
}

/** Set by the supervisor: the exit code that has it start this node again at once. */
const reloadExitCode = Number.parseInt(process.env.REINS_NODE_RELOAD_EXIT_CODE ?? "", 10);
const reload: NodeReloader | undefined = Number.isInteger(reloadExitCode) ? {
  // Bundles this node's own sources (dependencies stay external), so a syntax or import error refuses the
  // reload instead of leaving the node down.
  async check() {
    const result = await Bun.build({ entrypoints: [import.meta.path], target: "bun", packages: "external", throw: false });
    if (!result.success) throw new Error(result.logs.map(entry => entry.message).join("\n") || "build failed");
  },
  restart: () => {
    log("runs paused; restarting on new code");
    void stop(reloadExitCode);
  },
} : undefined;

/** Set by the supervisor: the exit code that has it leave this node stopped. */
const refusedExitCode = Number.parseInt(process.env.REINS_NODE_REFUSED_EXIT_CODE ?? "", 10);

const node = startNode({ dataDir, ...(reload ? { reload } : {}) });
const client = connectLocalNode(node, {
  path: socketPath,
  nodeId,
  onStatus: status => log(status === "connected" ? `connected to server at ${socketPath}` : "disconnected from server; redialing"),
  onRefused: message => {
    log(`refused by the server: ${message}; not reconnecting`);
    void shutdown(Number.isInteger(refusedExitCode) ? refusedExitCode : 1);
  },
});
log(`dialing server at ${socketPath} as node ${nodeId} (pid ${process.pid})`);

let stopping = false;
/** Closes the connection, closes every runtime without aborting its run and exits with `code`. Pause first. */
async function stop(code: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  client.stop();
  const timeout = new Promise<"timeout">(resolve => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS, "timeout").unref());
  if (await Promise.race([node.shutdown().then(() => "done" as const), timeout]) === "timeout") {
    console.error(`[node] runtimes did not close within ${SHUTDOWN_TIMEOUT_MS}ms; exiting anyway`);
  }
  log("stopped");
  process.exit(code);
}
/** Pauses every run (bounded by SHUTDOWN_PAUSE_MS, then cut off), then stops and exits with `code`. */
async function shutdown(code: number): Promise<void> {
  if (stopping) return;
  const { paused, blocking } = await node.pause({ timeoutMs: SHUTDOWN_PAUSE_MS, force: true });
  if (!paused || blocking.length > 0) log(`cutting off work still in flight: ${blocking.join(", ")}`);
  await stop(code);
}
const onSignal = (signal: string) => () => {
  if (stopping) return;
  log(`received ${signal}; pausing runs`);
  void shutdown(0);
};
process.on("SIGTERM", onSignal("SIGTERM"));
process.on("SIGINT", onSignal("SIGINT"));

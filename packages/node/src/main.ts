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
 */
import { connectLocalNode } from "./local-link.js";
import { startNode } from "./node.js";
import { nodeStoragePath, openNodeDb } from "./storage.js";
import { defaultLocalNodeSocketPath } from "./protocol/local-link.js";

/** A run that does not finish aborting in time is cut off, as by a crash. */
const SHUTDOWN_TIMEOUT_MS = 5_000;

const log = (message: string) => console.log(`[node] ${message}`);
const socketPath = process.env.REINS_NODE_SOCKET?.trim() || defaultLocalNodeSocketPath();

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
const client = connectLocalNode(node, {
  path: socketPath,
  onStatus: status => log(status === "connected" ? `connected to server at ${socketPath}` : "disconnected from server; redialing"),
});
log(`dialing server at ${socketPath}`);

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log(`received ${signal}; stopping`);
  client.stop();
  const timeout = new Promise<"timeout">(resolve => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS, "timeout").unref());
  if (await Promise.race([node.shutdown().then(() => "done" as const), timeout]) === "timeout") {
    console.error(`[node] active runs did not stop within ${SHUTDOWN_TIMEOUT_MS}ms; exiting anyway`);
  }
  db.close();
  log("stopped");
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

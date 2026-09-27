/**
 * Server State Helper
 *
 * Creates a ServerState (process state plus a node hub, as `handler.install()` gives it) for route, WS
 * and model tests. The hub is not started: no periodic scan runs; wakes deliver.
 */

import { randomBytes } from "crypto";
import { initEncryptionSecret } from "../../crypto.js";
import { installNodeHub, type NodeHubOptions } from "../../runtimes/node-hub.js";
import type { ProcessState, ServerState } from "../../state.js";
import { connectLoopbackNode } from "./loopback-node.js";

/** Initialize the module-level encryption secret for tests. */
const TEST_SECRET = randomBytes(32);
initEncryptionSecret(TEST_SECRET);

/** No node is connected unless the test connects one (`useFakeNode`, `connectLoopbackNode`, a socket).
 * `loopbackNode`: an in-process node on the current test node database connects as the seeded node over
 * the in-memory loopback test utility. `hub`: hub options (e.g. short command timeouts). */
export function createServerState(
  overrides?: Partial<ProcessState>,
  { loopbackNode = false, hub }: { loopbackNode?: boolean; hub?: NodeHubOptions } = {},
): ServerState {
  const state = installNodeHub({ clients: new Set(), frontendDir: "/tmp/nonexistent", ...overrides }, hub);
  if (loopbackNode) connectLoopbackNode(state);
  return state;
}

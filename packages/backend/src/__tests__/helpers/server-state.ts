/**
 * Server State Helper
 *
 * Creates process-owned ServerState (clients, frontend directory and node hub) for route, WS
 * and model tests. The hub is not started: no periodic scan runs; wakes deliver.
 */

import { randomBytes } from "crypto";
import { initEncryptionSecret } from "../../crypto.js";
import { createNodeHub, type NodeHubOptions, type NodeHubServices } from "../../node-link/node-hub.js";
import { nodeServerServices } from "../../nodes/node-services.js";
import type { ServerState } from "../../state.js";
import { connectLoopbackNode } from "./loopback-node.js";

/** Initialize the module-level encryption secret for tests. */
const TEST_SECRET = randomBytes(32);
initEncryptionSecret(TEST_SECRET);

/** No node is connected unless the test connects one (`useFakeNode`, `connectLoopbackNode`, a socket).
 * `loopbackNode`: an in-process node on the current test node database connects as the seeded node over
 * the in-memory loopback test utility. `hub`: hub options (e.g. short command timeouts). */
export function createServerState(
  overrides?: Partial<ServerState>,
  { loopbackNode = false, hub }: { loopbackNode?: boolean; hub?: NodeHubOptions } = {},
): ServerState {
  let services: NodeHubServices | undefined;
  const clients = overrides?.clients ?? new Set();
  const state: ServerState = {
    clients, frontendDir: "/tmp/nonexistent", ...overrides,
    nodes: createNodeHub(clients, () => services ??= nodeServerServices(state), hub),
  };
  if (loopbackNode) connectLoopbackNode(state);
  return state;
}

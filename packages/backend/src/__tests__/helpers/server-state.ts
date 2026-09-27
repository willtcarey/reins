/**
 * Server State Helper
 *
 * Creates a minimal ServerState for route and WS handler tests.
 */

import { randomBytes } from "crypto";
import { initEncryptionSecret } from "../../crypto.js";
import { installRuntimeHooks } from "../../runtime-hooks.js";
import type { ServerState } from "../../state.js";
import { useLoopbackNode } from "./loopback-node.js";

/** Initialize the module-level encryption secret for tests. */
const TEST_SECRET = randomBytes(32);
initEncryptionSecret(TEST_SECRET);

/** `loopbackNode` (default): commands reach an in-process node over the in-memory loopback test utility,
 * started on first use. Pass `false` when the test links a node itself (e.g. over a real socket). */
export function createServerState(overrides?: Partial<ServerState>, { loopbackNode = true }: { loopbackNode?: boolean } = {}): ServerState {
  const state: ServerState = {
    sessions: new Map(),
    clients: new Set(),
    frontendDir: "/tmp/nonexistent",
    ...overrides,
  };
  installRuntimeHooks(state);
  if (loopbackNode) useLoopbackNode(state);
  return state;
}

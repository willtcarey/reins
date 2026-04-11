/**
 * Server State Helper
 *
 * Creates a minimal ServerState for route and WS handler tests.
 */

import { randomBytes } from "crypto";
import { initEncryptionSecret } from "../../crypto.js";
import { registerBuiltinRuntimeAdapters } from "../../runtimes/register-builtins.js";
import type { ServerState } from "../../state.js";

/** Initialize the module-level encryption secret for tests. */
const TEST_SECRET = randomBytes(32);
initEncryptionSecret(TEST_SECRET);

export function createServerState(overrides?: Partial<ServerState>): ServerState {
  registerBuiltinRuntimeAdapters();

  return {
    sessions: new Map(),
    clients: new Set(),
    frontendDir: "/tmp/nonexistent",
    ...overrides,
  };
}

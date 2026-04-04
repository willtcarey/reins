/**
 * Test Server State Helper
 *
 * Creates a minimal ServerState for route and WS handler tests.
 */

import { randomBytes } from "crypto";
import type { ServerState } from "../../state.js";

/** A stable test secret — reused across calls so tests can share encrypted data. */
const TEST_SECRET = randomBytes(32);

export function createTestState(overrides?: Partial<ServerState>): ServerState {
  return {
    sessions: new Map(),
    clients: new Set(),
    frontendDir: "/tmp/nonexistent",
    explicitModel: undefined,
    encryptionSecret: TEST_SECRET,
    ...overrides,
  };
}

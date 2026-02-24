/**
 * Test Server State Helper
 *
 * Creates a minimal ServerState for route and WS handler tests.
 */

import type { ServerState } from "../../state.js";

export function createTestState(overrides?: Partial<ServerState>): ServerState {
  return {
    sessions: new Map(),
    clients: new Set(),
    frontendDir: "/tmp/nonexistent",
    explicitModel: undefined,
    ...overrides,
  };
}

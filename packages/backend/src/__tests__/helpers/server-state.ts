/**
 * Server State Helper
 *
 * Creates ServerState (clients, frontend directory, the process's sessions and a node hub, as a handler
 * load builds it) for route, WS and model tests. Unless a test brings its own process sessions (to serve
 * loads itself, `session-host.ts`), the state gets fresh ones its load serves at once, so session
 * runtimes open and run on it; they are closed before the test database (`useTestDb`) closes, or by
 * `closeSessions`.
 */

import { afterEach, beforeEach } from "bun:test";
import { createHash, randomBytes } from "crypto";
import { initEncryptionSecret } from "../../crypto.js";
import type { NodeHubOptions } from "../../nodes/node-hub.js";
import type { NodeBundle } from "../../node-bundle/build.js";
import { serveNodeBundle, type NodeBundleDelivery } from "../../node-bundle/delivery.js";
import { createServerState as createLoadState } from "../../state.js";
import type { ProcessSessions, ServerState, WsClient } from "../../state.js";
import { createProcessSessions } from "../../process-state.js";
import { loadServices } from "../../session-runtime/load-services.js";
import { connectLoopbackNode, stopLoopbackNode } from "./loopback-node.js";
import { onTestDbTeardown } from "./test-db.js";

/** Initialize the module-level encryption secret for tests. */
const TEST_SECRET = randomBytes(32);
initEncryptionSecret(TEST_SECRET);

/** A node bundle for tests that do not build one: a few bytes of JS, under their sha256. */
export function testNodeBundle(source = "console.log(\"reins\");\n"): NodeBundle {
  const bytes = new TextEncoder().encode(source);
  return { bytes, buildId: createHash("sha256").update(bytes).digest("hex") };
}

/** No node is connected unless the test connects one (`connectLoopbackNode`, a socket). `loopbackNode`:
 * an in-process node on the current test node database connects as the seeded node over the in-memory
 * loopback test utility. `hub`: hub options. `/nodes/*` serves `testNodeBundle()` unless `nodeBundle` is
 * given. Without `sessions`, the state's load serves fresh process sessions. */
export function createServerState(
  overrides?: { clients?: Set<WsClient>; frontendDir?: string; nodeBundle?: NodeBundleDelivery; sessions?: ProcessSessions },
  { loopbackNode = false, hub }: { loopbackNode?: boolean; hub?: NodeHubOptions } = {},
): ServerState {
  const nodeBundle = overrides?.nodeBundle ?? serveNodeBundle(Promise.resolve(testNodeBundle()), { bunVersion: Bun.version });
  const sessions = overrides?.sessions ?? createProcessSessions();
  const state = createLoadState(overrides?.clients ?? new Set(), overrides?.frontendDir ?? "/tmp/nonexistent", nodeBundle, sessions, { hub });
  if (!overrides?.sessions) {
    sessions.serve(loadServices(state));
    onTestDbTeardown(() => closeSessions(state));
  }
  if (loopbackNode) connectLoopbackNode(state);
  return state;
}

/** Closes every live runtime of the state's process sessions (aborting their runs), once the openings in
 * progress and submissions settled, until none is open (a run ending may open its parent's). Await it
 * before the test's database goes. */
export async function closeSessions(state: Pick<ServerState, "sessions">): Promise<void> {
  const { sessions } = state;
  for (let round = 0; round < 5; round++) {
    await Promise.allSettled([...sessions.opening.values(), ...sessions.submissions.values()]);
    if (sessions.live.size === 0) return;
    const entries = [...sessions.live.values()];
    sessions.live.clear();
    await Promise.allSettled(entries.map(entry => entry.runtime.close()));
  }
}

/** Registers hooks giving each test a fresh `ServerState` whose seeded node is an in-process node
 * (`loopbackNode`), so models reach the project's checkout through it; stopped after each test. Call
 * after `useTestDb()`. */
export function useLoopbackState(): { readonly state: ServerState } {
  let state: ServerState | undefined;
  beforeEach(() => { state = createServerState(undefined, { loopbackNode: true }); });
  afterEach(async () => {
    if (!state) return;
    await closeSessions(state);
    await stopLoopbackNode(state);
    await state.nodes.close();
  });
  return { get state() { if (!state) throw new Error("useLoopbackState: no test is running"); return state; } };
}

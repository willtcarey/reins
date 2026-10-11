/**
 * Server State Helper
 *
 * Creates ServerState (clients, frontend directory and a node hub, as a handler load builds it) for
 * route, WS and model tests. The hub is not started: no periodic scan runs; wakes deliver.
 */

import { afterEach, beforeEach } from "bun:test";
import { createHash, randomBytes } from "crypto";
import { initEncryptionSecret } from "../../crypto.js";
import type { NodeHubOptions } from "../../nodes/node-hub.js";
import type { NodeBundle } from "../../node-bundle/build.js";
import { serveNodeBundle, type NodeBundleDelivery } from "../../node-bundle/delivery.js";
import { createServerState as createLoadState } from "../../state.js";
import type { ServerState, WsClient } from "../../state.js";
import { connectLoopbackNode, stopLoopbackNode } from "./loopback-node.js";

/** Initialize the module-level encryption secret for tests. */
const TEST_SECRET = randomBytes(32);
initEncryptionSecret(TEST_SECRET);

/** A node bundle for tests that do not build one: a few bytes of JS, under their sha256. */
export function testNodeBundle(source = "console.log(\"reins\");\n"): NodeBundle {
  const bytes = new TextEncoder().encode(source);
  return { bytes, buildId: createHash("sha256").update(bytes).digest("hex") };
}

/** No node is connected unless the test connects one (`useFakeNode`, `connectLoopbackNode`, a socket).
 * `loopbackNode`: an in-process node on the current test node database connects as the seeded node over
 * the in-memory loopback test utility. `hub`: hub options (e.g. short command timeouts). `/nodes/*` serves
 * `testNodeBundle()` unless `nodeBundle` is given. */
export function createServerState(
  overrides?: { clients?: Set<WsClient>; frontendDir?: string; nodeBundle?: NodeBundleDelivery },
  { loopbackNode = false, hub }: { loopbackNode?: boolean; hub?: NodeHubOptions } = {},
): ServerState {
  const nodeBundle = overrides?.nodeBundle ?? serveNodeBundle(Promise.resolve(testNodeBundle()), { bunVersion: Bun.version });
  const state = createLoadState(overrides?.clients ?? new Set(), overrides?.frontendDir ?? "/tmp/nonexistent", nodeBundle, hub);
  if (loopbackNode) connectLoopbackNode(state);
  return state;
}

/** Registers hooks giving each test a fresh `ServerState` whose seeded node is an in-process node
 * (`loopbackNode`), so models reach the project's checkout through it; stopped after each test. Call
 * after `useTestDb()`. */
export function useLoopbackState(): { readonly state: ServerState } {
  let state: ServerState | undefined;
  beforeEach(() => { state = createServerState(undefined, { loopbackNode: true }); });
  afterEach(async () => {
    if (!state) return;
    await stopLoopbackNode(state);
    state.nodes.close();
  });
  return { get state() { if (!state) throw new Error("useLoopbackState: no test is running"); return state; } };
}

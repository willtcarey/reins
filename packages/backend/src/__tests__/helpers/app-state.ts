/**
 * App State Helper
 *
 * Creates an app's state (`AppState`: a node bundle around a process) for route, WS and model tests, on a
 * test process (`testProcess`: the database, browser connections a test can add to, node hub and
 * `/nodes/link`, open sessions, credential locks and app registration of a `ServerProcess`). Unless a test
 * brings its own process (to register apps itself, `session-host.ts`), the state gets a fresh one with
 * its app registered at once, so session runtimes open and run on it and the hub serves nodes; they are
 * closed before the test database (`useTestDb`) closes, or by `closeSessions`.
 */

import { afterEach, beforeEach } from "bun:test";
import { createHash, randomBytes } from "crypto";
import { initEncryptionSecret } from "../../crypto.js";
import { getDb } from "../../db.js";
import type { NodeHubOptions } from "../../nodes/node-hub.js";
import type { HubAppOptions } from "../../nodes/hub-app.js";
import type { NodeBundle } from "../../node-bundle/build.js";
import { serveNodeBundle, type NodeBundleDelivery } from "../../node-bundle/delivery.js";
import { createAppState as buildAppState } from "../../state.js";
import type { AppState, ServerProcess, WsClient } from "../../state.js";
import { createServerProcess, type ServerProcessOptions } from "../../process-state.js";
import { createApp } from "../../app.js";
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

/** A process for tests, with the browser connections its broadcast reaches (`clients`), which a test adds to. */
export type TestProcess = ServerProcess & { clients: Set<WsClient> };
/** An app's state on a test process. */
export type TestAppState = AppState & { process: TestProcess };

/** A `ServerProcess` as `server-process.ts` creates one, on the test database (`getDb()` at each use: a
 * test's database is set up after its state may have been created). */
export function testProcess({ clients = new Set(), frontendDir = "/tmp/nonexistent", ...options }: { clients?: Set<WsClient>; frontendDir?: string } & ServerProcessOptions = {}): TestProcess {
  const serverProcess = createServerProcess({
    get db() { return getDb(); },
    broadcast(frame) {
      for (const client of clients) {
        try { client.ws.send(frame); } catch { /* a closing socket */ }
      }
    },
    frontendDir,
  }, options);
  return Object.assign(serverProcess, { clients });
}

/** No node is connected unless the test connects one (`connectLoopbackNode`, a socket). `loopbackNode`:
 * an in-process node on the current test node database connects as the seeded node over the in-memory
 * loopback test utility. `hub`: the fresh process's hub options; `hubApp`: the app's answers to the hub.
 * `/nodes/*` serves `testNodeBundle()` unless `nodeBundle` is given. Without `process`, the state's app is
 * registered with a fresh test process (`clients` and `frontendDir` are its). */
export function createAppState(
  overrides?: { process?: TestProcess; clients?: Set<WsClient>; frontendDir?: string; nodeBundle?: NodeBundleDelivery },
  { loopbackNode = false, hub, hubApp }: { loopbackNode?: boolean; hub?: NodeHubOptions; hubApp?: HubAppOptions } = {},
): TestAppState {
  const nodeBundle = overrides?.nodeBundle ?? serveNodeBundle(Promise.resolve(testNodeBundle()), { bunVersion: Bun.version });
  const serverProcess = overrides?.process ?? testProcess({ clients: overrides?.clients, frontendDir: overrides?.frontendDir, hub });
  const state = Object.assign(buildAppState(serverProcess, nodeBundle), { process: serverProcess });
  if (!overrides?.process) {
    serverProcess.registerApp(createApp(state, { hub: hubApp }));
    onTestDbTeardown(() => closeSessions(serverProcess));
  }
  if (loopbackNode) connectLoopbackNode(state);
  return state;
}

/** Closes every live runtime of the process's sessions (aborting their runs), once the openings in
 * progress and submissions settled, until none is open (a run ending may open its parent's). Await it
 * before the test's database goes. */
export async function closeSessions(serverProcess: ServerProcess): Promise<void> {
  const { sessions } = serverProcess;
  for (let round = 0; round < 5; round++) {
    await Promise.allSettled([...sessions.opening.values(), ...sessions.submissions.values()]);
    if (sessions.live.size === 0) return;
    const entries = [...sessions.live.values()];
    sessions.live.clear();
    await Promise.allSettled(entries.map(entry => entry.runtime.close()));
  }
}

/** Registers hooks giving each test a fresh app state whose seeded node is an in-process node
 * (`loopbackNode`), so models reach the project's checkout through it; stopped after each test. Call
 * after `useTestDb()`. */
export function useLoopbackState(): { readonly state: TestAppState } {
  let state: TestAppState | undefined;
  beforeEach(() => { state = createAppState(undefined, { loopbackNode: true }); });
  afterEach(async () => {
    if (!state) return;
    await closeSessions(state.process);
    await stopLoopbackNode(state);
    await state.process.nodes.close();
  });
  return { get state() { if (!state) throw new Error("useLoopbackState: no test is running"); return state; } };
}

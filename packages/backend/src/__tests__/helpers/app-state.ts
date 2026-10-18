/**
 * App State Helper
 *
 * Creates an app's state (`AppState`: a node hub, `/nodes/link` and node bundle around a process) for
 * route, WS and model tests, on a test process (`testProcess`: the database, browser connections a test
 * can add to, open sessions, credential locks, app registration and run reports of a `ServerProcess`). Unless a test
 * brings its own process (to register apps itself, `session-host.ts`), the state gets a fresh one with
 * its app registered at once, so session runtimes open and run on it; they are closed before the test
 * database (`useTestDb`) closes, or by `closeSessions`.
 */

import { afterEach, beforeEach } from "bun:test";
import { createHash, randomBytes } from "crypto";
import { initEncryptionSecret } from "../../crypto.js";
import { getDb, useOpenSessions } from "../../app-globals.js";
import type { NodeHubOptions } from "../../nodes/node-hub.js";
import type { NodeBundle } from "../../node-bundle/build.js";
import { serveNodeBundle, type NodeBundleDelivery } from "../../node-bundle/delivery.js";
import { createAppState as buildAppState } from "../../state.js";
import type { AppState, ServerProcess, SessionRuntime, WsClient } from "../../state.js";
import { createServerProcess, type OpenSessionsOptions } from "../../process-state.js";
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
 * test's database is set up after its state may have been created). The stores derive sessions' running
 * state from its open sessions, as from those of the process an app starts in (`injectProcessState`). */
export function testProcess({ clients = new Set(), frontendDir = "/tmp/nonexistent", ...options }: { clients?: Set<WsClient>; frontendDir?: string } & OpenSessionsOptions = {}): TestProcess {
  const serverProcess = createServerProcess({
    get db() { return getDb(); },
    broadcast(frame) {
      for (const client of clients) {
        try { client.ws.send(frame); } catch { /* a closing socket */ }
      }
    },
    frontendDir, nodeSocket: "/tmp/reins-test-unused.sock",
  }, options);
  useOpenSessions(serverProcess.sessions);
  return Object.assign(serverProcess, { clients });
}

const unsupported = () => Promise.reject(new Error("stub runtime"));
/** Puts a stand-in live runtime for `sessionId` in the process's open sessions: busy while `busy()` (a
 * run in progress), with no model or node. Its other operations fail. Returns `wentIdle`, the idle edge:
 * it resolves `whenIdle`'s waiters once `busy()` is false (call it after changing what `busy` reads). */
export function stubRuntime(serverProcess: ServerProcess, sessionId: string, { busy = () => true }: { busy?: () => boolean } = {}): { wentIdle(): void } {
  const idleWaiters: Array<() => void> = [];
  const runtime: SessionRuntime = {
    prompt: unsupported, steer: unsupported, setModel: unsupported, abort: async () => {}, resumePendingOperation: async () => false,
    isStreaming: busy, isBusy: busy, whenIdle: () => busy() ? new Promise<void>(resolve => idleWaiters.push(resolve)) : Promise.resolve(),
    isPaused: () => true, close: async () => {}, suspend: async () => {},
  };
  serverProcess.sessions.live.set(sessionId, { runtime, binding: "{}", lastActivity: Date.now(), retired: false, faulted: false });
  return { wentIdle: () => { if (!busy()) for (const resolve of idleWaiters.splice(0)) resolve(); } };
}

/** No node is connected unless the test connects one (`connectLoopbackNode`, a socket). `loopbackNode`:
 * an in-process node on the current test node database connects as the seeded node over the in-memory
 * loopback test utility. `hub`: hub options. `/nodes/*` serves `testNodeBundle()` unless `nodeBundle` is
 * given. Without `process`, the state's app is registered with a fresh test process (`clients` and
 * `frontendDir` are its). */
export function createAppState(
  overrides?: { process?: TestProcess; clients?: Set<WsClient>; frontendDir?: string; nodeBundle?: NodeBundleDelivery },
  { loopbackNode = false, hub }: { loopbackNode?: boolean; hub?: NodeHubOptions } = {},
): TestAppState {
  const nodeBundle = overrides?.nodeBundle ?? serveNodeBundle(Promise.resolve(testNodeBundle()), { bunVersion: Bun.version });
  const serverProcess = overrides?.process ?? testProcess({ clients: overrides?.clients, frontendDir: overrides?.frontendDir });
  // The same object the hub and `/nodes/link` hold, typed with its test process.
  const state = Object.assign(buildAppState(serverProcess, nodeBundle, { hub }), { process: serverProcess });
  if (!overrides?.process) {
    serverProcess.registerApp(createApp(state));
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
    await state.nodes.close();
  });
  return { get state() { if (!state) throw new Error("useLoopbackState: no test is running"); return state; } };
}

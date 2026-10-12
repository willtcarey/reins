/**
 * The node hub is the process's and asks the current app at each use (`App.hub`, ADR-029): a reload of the
 * app leaves node links open, and a hello arriving while no app is current waits for the next app, whose
 * answer it gets (ready, update or refusal), against that app's rows and node bundle.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import { scriptedNode } from "@reins/node/testing";
import { serveNodeBundle } from "../../node-bundle/delivery.js";
import { getDb } from "../../db.js";
import { logger } from "../../logger.js";
import { setNodeRemoved } from "../../node-store.js";
import { useTestDb } from "../helpers/test-db.js";
import { closeSessions, createAppState, testNodeBundle, testProcess, type TestProcess } from "../helpers/app-state.js";
import { dialLoopback, SEEDED_NODE_ID, type LoopbackLink } from "../helpers/loopback-node.js";
import { startApp } from "../helpers/session-host.js";

useTestDb();
const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).toReversed()) await cleanup(); });

const OLD_BUILD = "0".repeat(64);

/** A process with no app yet; `nodes.close()` and its sessions are cleaned up after the test. */
function processWithoutApp(): TestProcess {
  const serverProcess = testProcess();
  cleanups.push(async () => { await closeSessions(serverProcess); await serverProcess.nodes.close(); });
  return serverProcess;
}

/** Starts an app on `serverProcess` serving node bundle `source`; returns its stop. */
function startAppServing(serverProcess: TestProcess, source = "console.log(\"reins\");\n"): () => void {
  const stop = startApp(createAppState({ process: serverProcess, nodeBundle: serveNodeBundle(Promise.resolve(testNodeBundle(source)), { bunVersion: "1.3.9" }) }));
  cleanups.push(stop);
  return stop;
}

/** A stand-in node saying hello as `nodeId` (announcing `buildId`, if any) that does not redial. */
function dial(serverProcess: TestProcess, { nodeId = SEEDED_NODE_ID, buildId }: { nodeId?: string; buildId?: string } = {}): LoopbackLink {
  const link = dialLoopback(createAppState({ process: serverProcess }), scriptedNode(), { nodeId, buildId, redial: false });
  cleanups.push(() => link.stop());
  return link;
}

/** Whether `promise` is still pending after `ms`. */
async function pendingAfter(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  await Bun.sleep(ms);
  return !settled;
}

test("a reload of the app keeps every node's link: the node is not dropped during the gap, never redials, and its calls go on", async () => {
  const serverProcess = processWithoutApp();
  const stopFirst = startAppServing(serverProcess);
  const link = dialLoopback(createAppState({ process: serverProcess }), scriptedNode({ envExecKill: async () => ({ killed: true }) }), { redial: true });
  cleanups.push(() => link.stop());
  await link.ready();

  stopFirst();
  expect(serverProcess.nodes.get(SEEDED_NODE_ID).connected).toBe(true);
  expect(await serverProcess.nodes.get(SEEDED_NODE_ID).request("env.execKill", { execId: "during" })).toEqual({ killed: true });
  startAppServing(serverProcess);

  expect(serverProcess.nodes.get(SEEDED_NODE_ID).connected).toBe(true);
  expect(await serverProcess.nodes.get(SEEDED_NODE_ID).request("env.execKill", { execId: "after" })).toEqual({ killed: true });
  expect(link.dials()).toBe(1);
});

test("a hello while no app is current waits for the next app, and is served by it", async () => {
  const serverProcess = processWithoutApp();
  startAppServing(serverProcess)();
  const link = dial(serverProcess);

  expect(await pendingAfter(link.ready(), 100)).toBe(true);
  expect(serverProcess.nodes.get(SEEDED_NODE_ID).connected).toBe(false);
  startAppServing(serverProcess);

  await link.ready();
  expect(serverProcess.nodes.get(SEEDED_NODE_ID).connected).toBe(true);
});

test("a hello waiting for the next app gets that app's refusal for a node removed meanwhile", async () => {
  const serverProcess = processWithoutApp();
  const link = dial(serverProcess);
  expect(await pendingAfter(link.ready(), 50)).toBe(true);

  setNodeRemoved(SEEDED_NODE_ID, new Date().toISOString());
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  cleanups.push(() => warn.mockRestore());
  startAppServing(serverProcess);

  await expect(link.ready()).rejects.toMatchObject({ reason: "refused", message: `Node removed: ${SEEDED_NODE_ID}` });
});

test("a node bundle's hello is answered against the current app's build: one waiting through the gap is told to update to the next app's, and so is one on the previous app's build", async () => {
  const serverProcess = processWithoutApp();
  const first = testNodeBundle("first");
  const second = testNodeBundle("second");
  const stopFirst = startAppServing(serverProcess, "first");
  const current = dial(serverProcess, { buildId: first.buildId });
  await current.ready();
  expect(serverProcess.nodes.get(SEEDED_NODE_ID).build).toEqual({ id: first.buildId, status: "current" });

  stopFirst();
  getDb().exec("INSERT INTO nodes (id, name) VALUES ('laptop', 'Laptop')");
  const waiting = dial(serverProcess, { nodeId: "laptop", buildId: OLD_BUILD });
  expect(await pendingAfter(waiting.ready(), 50)).toBe(true);
  startAppServing(serverProcess, "second");

  const update = { buildId: second.buildId, sha256: second.buildId, bunVersion: "1.3.9" };
  await expect(waiting.ready()).rejects.toMatchObject({ reason: "update", update });
  // The node still linked on the first app's build keeps its link; its next hello is told to update.
  expect(serverProcess.nodes.get(SEEDED_NODE_ID).connected).toBe(true);
  current.stop();
  await expect(dial(serverProcess, { buildId: first.buildId }).ready()).rejects.toMatchObject({ reason: "update", update });
});

/**
 * Which build a node runs: a node bundle announces its build in `node.hello`, and a server whose own build
 * differs answers `update` instead of negotiating (ADR-025). The settings page sees each node's build.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import { authenticateParams, authenticateResult, createRpcPeer, generateNodeKeyPair, helloResult, NEGOTIATION_FAILED, protocolVersion, signNodeChallenge, type NodeChallenge, type NodeKey } from "@reins/node-protocol";
import { createLoopbackPair } from "@reins/node-protocol/testing";
import { scriptedNode } from "@reins/node/testing";
import { useTestDb } from "../helpers/test-db.js";
import { createAppState, testNodeBundle, type TestAppState } from "../helpers/app-state.js";
import { dialLoopback, SEEDED_NODE_ID } from "../helpers/loopback-node.js";
import { serveNodeBundle } from "../../node-bundle/delivery.js";
import type { NodeBundle } from "../../node-bundle/build.js";
import { Nodes } from "../../models/nodes.js";
import { logger } from "../../logger.js";

useTestDb();
const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).toReversed()) await cleanup(); });

const SERVER_BUILD = testNodeBundle();
const OLD_BUILD = "0".repeat(64);
const ORIGIN = "https://reins.example.test";
const until = async (condition: () => boolean) => { for (let i = 0; i < 400 && !condition(); i++) await Bun.sleep(5); expect(condition()).toBe(true); };

/** A server state serving `bundle` (built for Bun 1.3.9), recording what browsers are told. */
function serverServing(bundle: Promise<NodeBundle>, { buildWaitMs }: { buildWaitMs?: number } = {}) {
  const state = createAppState({ nodeBundle: serveNodeBundle(bundle, { bunVersion: "1.3.9" }) }, { hubApp: buildWaitMs === undefined ? {} : { buildWaitMs } });
  cleanups.push(() => state.process.nodes.close());
  const browser: Array<{ type: string; node?: unknown }> = [];
  state.process.clients.add({ ws: { send: data => { browser.push(JSON.parse(data)); return 0; } } });
  return { state, browser, view: (nodeId = SEEDED_NODE_ID) => new Nodes(state, () => {}).get(nodeId).view() };
}

/** A stand-in node (the node's own `connectNode`) saying hello as `nodeId`, announcing `buildId` (none: from
 * source), and authenticating with `key` if given. */
function dialNode(state: TestAppState, { nodeId = SEEDED_NODE_ID, buildId, key }: { nodeId?: string; buildId?: string; key?: NodeKey } = {}) {
  const link = dialLoopback(state, scriptedNode(), { nodeId, buildId, key, redial: false, ...(key ? { authenticate: { origin: ORIGIN } } : {}) });
  cleanups.push(() => link.stop());
  return link;
}

/** A raw node end's hello as the seeded node, announcing `buildId` and offering protocol `version` (which
 * `connectNode` cannot vary): the server's reply, or its error. */
function rawHello(state: TestAppState, { buildId, version = protocolVersion }: { buildId: string; version?: number }) {
  const [serverEnd, nodeEnd] = createLoopbackPair();
  state.process.nodes.accept(serverEnd, { maxFrameBytes: Infinity });
  const peer = createRpcPeer(nodeEnd, {});
  nodeEnd.onmessage = peer.receive; nodeEnd.onclose = peer.close;
  cleanups.push(() => nodeEnd.close());
  return peer.call("node.hello", { nodeId: SEEDED_NODE_ID, minVersion: version, maxVersion: version, capabilities: [], buildId }, helloResult);
}

test("a node announcing another build than the server's is told to update to it, whatever protocol it speaks, and is not linked; browsers see it updating", async () => {
  for (const version of [protocolVersion, protocolVersion + 1]) {
    const { state, browser, view } = serverServing(Promise.resolve(SERVER_BUILD));

    expect(await rawHello(state, { buildId: OLD_BUILD, version })).toEqual({ kind: "update", buildId: SERVER_BUILD.buildId, sha256: SERVER_BUILD.buildId, bunVersion: "1.3.9" });
    expect({ connected: state.process.nodes.get(SEEDED_NODE_ID).connected, build: view().build }).toEqual({ connected: false, build: { id: OLD_BUILD, status: "updating" } });
    expect(browser.filter(message => message.type === "node_updated").at(-1)?.node).toMatchObject({ id: SEEDED_NODE_ID, build: { id: OLD_BUILD, status: "updating" } });
  }
  // A node reads the reply as the build to install, and stops dialing.
  const { state } = serverServing(Promise.resolve(SERVER_BUILD));
  await expect(dialNode(state, { buildId: OLD_BUILD }).ready())
    .rejects.toMatchObject({ reason: "update", update: { buildId: SERVER_BUILD.buildId, sha256: SERVER_BUILD.buildId, bunVersion: "1.3.9" } });
});

/** The commands a node bundle of protocol 10 offered in its hello; protocol 11's added the tool host's. */
const PROTOCOL_10_CAPABILITIES = [
  "session.prompt", "session.steer", "session.setModel", "session.abort", "session.resumePending", "session.close",
  "skills.list", "process.run", "fs.list", "fs.read", "fs.write", "stream.cancel", "credentials.changed", "node.reload",
];
const PROTOCOL_11_CAPABILITIES = [...PROTOCOL_10_CAPABILITIES, "env.fs", "env.exec", "env.execAttach", "env.execKill", "checkout.environment"];

test("a paired node bundle of an earlier protocol, saying hello as it did (its live sessions, its session commands), is authenticated, read and told to update", async () => {
  const { state, view } = serverServing(Promise.resolve(SERVER_BUILD));
  const nodes = new Nodes(state, () => {});
  const { publicKey, privateKey } = generateNodeKeyPair();
  const pairing = nodes.pairing();
  const { nodeId } = pairing.redeem({ code: pairing.createCode().code, publicKey, hostname: "a-mac" });
  for (const [version, capabilities] of [[10, PROTOCOL_10_CAPABILITIES], [11, PROTOCOL_11_CAPABILITIES]] as const) {
    const [serverEnd, nodeEnd] = createLoopbackPair();
    state.process.nodes.accept(serverEnd, { maxFrameBytes: Infinity, authenticate: { origin: ORIGIN } });
    const peer = createRpcPeer(nodeEnd, {
      "node.authenticate": { params: authenticateParams, result: authenticateResult, handle: async (challenge: NodeChallenge) => signNodeChallenge({ origin: ORIGIN, privateKey }, nodeId, challenge) },
    });
    nodeEnd.onmessage = peer.receive; nodeEnd.onclose = peer.close;
    cleanups.push(() => nodeEnd.close());
    const hello = { nodeId, minVersion: version, maxVersion: version, capabilities, liveSessions: ["running-1", "running-2"], buildId: OLD_BUILD };

    expect(await peer.call("node.hello", hello, helloResult)).toEqual({ kind: "update", buildId: SERVER_BUILD.buildId, sha256: SERVER_BUILD.buildId, bunVersion: "1.3.9" });
    expect({ connected: state.process.nodes.get(nodeId).connected, build: view(nodeId).build }).toEqual({ connected: false, build: { id: OLD_BUILD, status: "updating" } });
  }
});

test("a node running the server's build negotiates and is shown current, from then until it disconnects; a node from source shows no build", async () => {
  const { state, view } = serverServing(Promise.resolve(SERVER_BUILD));

  const bundled = dialNode(state, { buildId: SERVER_BUILD.buildId });
  await bundled.ready();
  expect({ connected: state.process.nodes.get(SEEDED_NODE_ID).connected, build: view().build }).toEqual({ connected: true, build: { id: SERVER_BUILD.buildId, status: "current" } });
  bundled.stop();
  await until(() => !state.process.nodes.get(SEEDED_NODE_ID).connected);
  expect(view().build).toBeNull();

  await dialNode(state).ready();
  expect({ connected: state.process.nodes.get(SEEDED_NODE_ID).connected, build: view().build }).toEqual({ connected: true, build: null });
});

test("with no build to offer (it failed), a node bundle speaking this protocol is served as it is, logged, and shown outdated", async () => {
  const errors = spyOn(logger, "error").mockImplementation(() => {});
  const warnings = spyOn(logger, "warn").mockImplementation(() => {});
  cleanups.push(() => { errors.mockRestore(); warnings.mockRestore(); });
  const { state, view } = serverServing(Promise.reject(new Error("build failed")));

  await dialNode(state, { buildId: OLD_BUILD }).ready();

  expect({ connected: state.process.nodes.get(SEEDED_NODE_ID).connected, build: view().build }).toEqual({ connected: true, build: { id: OLD_BUILD, status: "outdated" } });
  expect(warnings.mock.calls.map(([message]) => String(message))).toContain(`Node ${SEEDED_NODE_ID} runs build ${OLD_BUILD.slice(0, 12)}, and this server has no node build to offer (its build failed); serving it as it is`);
});

test("while the server's build is still running past the bound, a node bundle's hello fails, to be retried", async () => {
  const { state } = serverServing(new Promise(() => {}), { buildWaitMs: 10 });

  await expect(rawHello(state, { buildId: OLD_BUILD })).rejects.toMatchObject({ code: NEGOTIATION_FAILED, message: "The server's node build is not ready yet" });
  expect(state.process.nodes.get(SEEDED_NODE_ID).connected).toBe(false);
});

test("a node is told to update only once it has proved its key, and never once revoked", async () => {
  const { state, view } = serverServing(Promise.resolve(SERVER_BUILD));
  const nodes = new Nodes(state, () => {});
  const { publicKey, privateKey } = generateNodeKeyPair();
  const pairing = nodes.pairing();
  const { nodeId } = pairing.redeem({ code: pairing.createCode().code, publicKey, hostname: "remote-host" });

  await expect(dialNode(state, { nodeId, buildId: OLD_BUILD, key: { origin: ORIGIN, privateKey: generateNodeKeyPair().privateKey } }).ready())
    .rejects.toMatchObject({ reason: "refused", message: "Not authenticated" });
  nodes.get(nodeId).revoke();
  await expect(dialNode(state, { nodeId, buildId: OLD_BUILD, key: { origin: ORIGIN, privateKey } }).ready())
    .rejects.toMatchObject({ reason: "refused", message: `Node revoked: ${nodeId}` });

  expect(view(nodeId).build).toBeNull();
});

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { z } from "zod";
import { authenticateParams, authenticateResult, createRpcPeer, readyResult, generateNodeKeyPair, signNodeChallenge, NODE_REFUSED, type NodeAnswer, type NodeChallenge, type NodeKey } from "@reins/node-protocol";
import { createLoopbackPair } from "@reins/node-protocol/testing";
import { useTestDb } from "../helpers/test-db.js";
import { createAppState, type TestAppState } from "../helpers/app-state.js";
import { connectLoopbackNode, connectScriptedNode, loopbackLink, rawHelloParams, SEEDED_NODE_ID, stopLoopbackNode } from "../helpers/loopback-node.js";
import { Nodes } from "../../models/nodes.js";
import { logger } from "../../logger.js";

useTestDb();
let state: TestAppState;
beforeEach(() => { state = createAppState(); });
afterEach(() => state.nodes.close());

const ORIGIN = "https://reins.example.test";
const authenticate = { origin: ORIGIN };
const until = async (condition: () => boolean) => { for (let i = 0; i < 400 && !condition(); i++) await Bun.sleep(5); expect(condition()).toBe(true); };
const otherKey = () => generateNodeKeyPair().privateKey;

/** Pairs a node through the real pairing code flow; its key signs for `ORIGIN`. */
function pairedNode(): { nodeId: string; key: NodeKey } {
  const { publicKey, privateKey } = generateNodeKeyPair();
  const pairing = new Nodes(state, () => {}).pairing();
  const { nodeId } = pairing.redeem({ code: pairing.createCode().code, publicKey, hostname: "remote-host" });
  return { nodeId, key: { origin: ORIGIN, privateKey } };
}

/** A raw node end on an authenticating connection through the hub's `accept` that says hello as
 * `helloNodeId` and answers the server's challenge with `answer` (any answer, e.g. one recorded on another
 * connection). `ready` is its hello's outcome; it serves `pi.execKill`, recording the commands it was
 * asked to kill (`kills`), and never closes the connection itself. */
function dialRawNode(helloNodeId: string, answer: (challenge: NodeChallenge) => NodeAnswer) {
  const [serverEnd, nodeEnd] = createLoopbackPair();
  state.nodes.accept(serverEnd, { maxFrameBytes: Infinity, authenticate });
  const kills: string[] = [];
  const killParams = z.looseObject({ execId: z.string() });
  const peer = createRpcPeer(nodeEnd, {
    "node.authenticate": { params: authenticateParams, result: authenticateResult, handle: async (challenge: NodeChallenge) => answer(challenge) },
    "pi.execKill": { params: killParams, result: z.unknown(), handle: async ({ execId }: z.infer<typeof killParams>) => { kills.push(execId); return { killed: true }; } },
  });
  nodeEnd.onmessage = peer.receive; nodeEnd.onclose = peer.close;
  const ready = peer.call("node.hello", rawHelloParams(helloNodeId), readyResult);
  ready.catch(() => undefined);
  return { ready, peer, kills, closed: () => nodeEnd.closed, stop: () => serverEnd.close() };
}

test("a paired node answers the challenge with its key, negotiates and is served calls", async () => {
  const { nodeId, key } = pairedNode();
  connectLoopbackNode(state, { nodeId, key, authenticate });
  try {
    await loopbackLink(state, nodeId).ready();
    expect(state.nodes.get(nodeId).connected).toBe(true);
    await expect(state.nodes.get(nodeId).request("pi.execKill", { execId: "none" })).rejects.toMatchObject({ data: { code: "not_found" } });
  } finally { await stopLoopbackNode(state, nodeId); }
});

test("an answer recorded on one connection is refused on the next; the first stays the link", async () => {
  const { nodeId, key } = pairedNode();
  let recorded: NodeAnswer | undefined;
  const first = dialRawNode(nodeId, challenge => (recorded = signNodeChallenge(key, nodeId, challenge)));
  await first.ready;
  const replay = dialRawNode(nodeId, () => recorded!);
  await expect(replay.ready).rejects.toMatchObject({ code: NODE_REFUSED, message: "Not authenticated" });
  expect(state.nodes.get(nodeId).connected).toBe(true);
  // The first connection is still its node's link.
  expect(await state.nodes.get(nodeId).request("pi.execKill", { execId: "e" })).toEqual({ killed: true });
  expect(first.kills).toEqual(["e"]);
  first.stop();
});

test("the challenge is consumed by the first answer: the hello is refused, and a second answer on the connection is not accepted", async () => {
  const { nodeId, key } = pairedNode();
  const [serverEnd, nodeEnd] = createLoopbackPair();
  state.nodes.accept(serverEnd, { authenticate });
  const frames: Array<{ id?: string | number; method?: string; params?: NodeChallenge; result?: unknown; error?: { code: number; message: string } }> = [];
  nodeEnd.onmessage = data => frames.push(JSON.parse(data));
  await until(() => frames.length === 1);
  const [challenge] = frames;
  expect(challenge!.method).toBe("node.authenticate");
  const reply = (result: NodeAnswer) => nodeEnd.send(JSON.stringify({ jsonrpc: "2.0", id: challenge!.id, result }));
  reply(signNodeChallenge({ ...key, privateKey: otherKey() }, nodeId, challenge!.params!));
  nodeEnd.send(JSON.stringify({ jsonrpc: "2.0", id: "hello", method: "node.hello", params: rawHelloParams(nodeId) }));
  await until(() => frames.some(frame => frame.id === "hello"));
  expect(frames.find(frame => frame.id === "hello")).toMatchObject({ error: { code: NODE_REFUSED, message: "Not authenticated" } });
  // A reply to a call no longer pending breaks the protocol: the server closes the connection.
  reply(signNodeChallenge(key, nodeId, challenge!.params!));
  await until(() => nodeEnd.closed);
  expect(state.nodes.get(nodeId).connected).toBe(false);
});

test("a hello for another node than the one the connection authenticated as is refused, even for a paired node", async () => {
  const a = pairedNode();
  const b = pairedNode();
  const impostor = dialRawNode(b.nodeId, challenge => signNodeChallenge(a.key, a.nodeId, challenge));
  await expect(impostor.ready).rejects.toMatchObject({ code: NODE_REFUSED, message: `Connection authenticated as node ${a.nodeId}, not ${b.nodeId}` });
  expect(state.nodes.get(a.nodeId).connected).toBe(false);
  expect(state.nodes.get(b.nodeId).connected).toBe(false);
});

test("an answer not signed by the node's paired key refuses the hello alike for known and unknown nodes, logging the node once but not the answer", async () => {
  const { nodeId, key } = pairedNode();
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    const refused = async (claimed: string, sign: (challenge: NodeChallenge) => NodeAnswer) => {
      const seen: Array<NodeChallenge & NodeAnswer> = [];
      const node = dialRawNode(claimed, challenge => { const answer = sign(challenge); seen.push({ ...challenge, ...answer }); return answer; });
      // The same answer whether or not the node exists.
      await expect(node.ready).rejects.toMatchObject({ code: NODE_REFUSED, message: "Not authenticated" });
      const logged = warn.mock.calls.map(call => call.join(" "));
      expect(logged.filter(line => line.includes(claimed))).toHaveLength(1);
      expect(logged.join("\n")).not.toContain(seen[0]!.nonce);
      expect(logged.join("\n")).not.toContain(seen[0]!.signature);
      expect(state.nodes.get(claimed).connected).toBe(false);
      warn.mockClear();
    };
    await refused(nodeId, challenge => signNodeChallenge({ ...key, privateKey: otherKey() }, nodeId, challenge));
    await refused(nodeId, challenge => signNodeChallenge({ ...key, origin: "https://elsewhere.example.test" }, nodeId, challenge));
    await refused("stranger", challenge => signNodeChallenge({ origin: ORIGIN, privateKey: otherKey() }, "stranger", challenge));
    // The seeded node was never paired: it has no key to authenticate with.
    await refused(SEEDED_NODE_ID, challenge => signNodeChallenge({ origin: ORIGIN, privateKey: otherKey() }, SEEDED_NODE_ID, challenge));
    // A node without a key refuses the challenge: refused the same way.
    const unpaired = connectScriptedNode(state, nodeId, {}, { authenticate, redial: false });
    await expect(unpaired.ready()).rejects.toMatchObject({ reason: "refused", message: "Not authenticated" });
  } finally { warn.mockRestore(); }
});

test("a connection that fails the challenge and never says hello is closed by the hello timeout", async () => {
  const { nodeId } = pairedNode();
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    const [serverEnd, nodeEnd] = createLoopbackPair();
    state.nodes.accept(serverEnd, { authenticate, helloTimeoutMs: 100 });
    const frames: Array<{ id: string | number; method?: string }> = [];
    nodeEnd.onmessage = data => frames.push(JSON.parse(data));
    await until(() => frames.length === 1);
    nodeEnd.send(JSON.stringify({ jsonrpc: "2.0", id: frames[0]!.id, result: { nodeId, signature: "not-a-signature" } }));
    await until(() => warn.mock.calls.some(call => call.join(" ").includes("authentication failed")));
    expect(nodeEnd.closed).toBe(false);
    await until(() => nodeEnd.closed);
  } finally { warn.mockRestore(); }
});

test("a second authenticated connection for a node replaces the first, which is closed", async () => {
  const { nodeId, key } = pairedNode();
  const first = dialRawNode(nodeId, challenge => signNodeChallenge(key, nodeId, challenge));
  await first.ready;
  const second = dialRawNode(nodeId, challenge => signNodeChallenge(key, nodeId, challenge));
  await second.ready;
  await until(() => first.closed());
  expect(state.nodes.get(nodeId).connected).toBe(true);
  expect(await state.nodes.get(nodeId).request("pi.execKill", { execId: "e" })).toEqual({ killed: true });
  expect([first.kills, second.kills]).toEqual([[], ["e"]]);
  second.stop();
});

test("revoking a node closes its authenticated link; its next connection proves its key but is refused at hello, logged, and never linked", async () => {
  const { nodeId, key } = pairedNode();
  const link = connectScriptedNode(state, nodeId, {}, { key, authenticate, redial: false });
  await link.ready();
  new Nodes(state, () => {}).get(nodeId).revoke();
  await until(() => !state.nodes.get(nodeId).connected);

  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    const again = connectScriptedNode(state, nodeId, {}, { key, authenticate, redial: false });
    await expect(again.ready()).rejects.toMatchObject({ reason: "refused", message: `Node revoked: ${nodeId}` });
    // The challenge checks only that it holds its paired key: revocation is refused at hello, on every transport.
    expect(warn.mock.calls.some(call => call.join(" ").includes(nodeId) && call.join(" ").includes("revoked"))).toBe(true);
    expect(warn.mock.calls.some(call => call.join(" ").includes("authentication failed"))).toBe(false);
    expect(state.nodes.get(nodeId).connected).toBe(false);
  } finally { warn.mockRestore(); }
});

test("an unauthenticated connection, as on the local socket, negotiates for any known node without a challenge", async () => {
  const paired = pairedNode();
  const local = connectScriptedNode(state, SEEDED_NODE_ID, {});
  const remote = connectScriptedNode(state, paired.nodeId, {});
  await Promise.all([local.ready(), remote.ready()]);
  expect([state.nodes.get(SEEDED_NODE_ID).connected, state.nodes.get(paired.nodeId).connected]).toEqual([true, true]);
  local.stop();
  remote.stop();
});

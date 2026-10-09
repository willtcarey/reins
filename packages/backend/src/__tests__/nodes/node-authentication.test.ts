import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { acknowledgedResult, APPLICATION_ERROR, authenticateParams, authenticateResult, createRpcPeer, protocolVersion, readyResult, generateNodeKeyPair, signNodeChallenge, UNAUTHORIZED, type NodeAnswer, type NodeChallenge, type NodeIdentity, type LinkSocket } from "@reins/node-protocol";
import { createLoopbackPair } from "@reins/node-protocol/testing";
import { useTestDb } from "../helpers/test-db.js";
import { createServerState } from "../helpers/server-state.js";
import { connectLoopbackNode, connectScriptedNode, dialLoopback, loopbackLink, SEEDED_NODE_ID, stopLoopbackNode } from "../helpers/loopback-node.js";
import { Nodes } from "../../models/nodes.js";
import { logger } from "../../logger.js";
import type { ServerState } from "../../state.js";

useTestDb();
let state: ServerState;
beforeEach(() => { state = createServerState(); });
afterEach(() => state.nodes.close());

const ORIGIN = "https://reins.example.test";
const authenticate = { origin: ORIGIN };
const until = async (condition: () => boolean) => { for (let i = 0; i < 400 && !condition(); i++) await Bun.sleep(5); expect(condition()).toBe(true); };
const otherKey = () => generateNodeKeyPair().privateKey;

/** Pairs a node through the real pairing code flow; its identity signs for `ORIGIN`. */
function pairedNode(): { nodeId: string; identity: NodeIdentity } {
  const { publicKey, privateKey } = generateNodeKeyPair();
  const pairing = new Nodes(state.nodes, () => {}).pairing();
  const { nodeId } = pairing.redeem({ code: pairing.createCode().code, publicKey, hostname: "remote-host" });
  return { nodeId, identity: { origin: ORIGIN, privateKey } };
}

/** A node end on an authenticating connection that says hello as `helloNodeId` and answers the server's
 * challenge with `answer` (any answer, e.g. one recorded on another connection). It never closes the
 * connection itself. */
function dialRawNode(helloNodeId: string, answer: (challenge: NodeChallenge) => NodeAnswer) {
  let peer!: ReturnType<typeof createRpcPeer>;
  let wire!: LinkSocket;
  const link = dialLoopback(state, socket => {
    wire = socket;
    peer = createRpcPeer(socket, {
      "node.authenticate": { params: authenticateParams, result: authenticateResult, handle: async (challenge: NodeChallenge) => answer(challenge) },
    });
    const ready = peer.call("node.hello", { nodeId: helloNodeId, minVersion: protocolVersion, maxVersion: protocolVersion, capabilities: [], liveSessions: [] }, readyResult);
    return { receive: peer.receive, close: peer.close, ready };
  }, { redial: false, authenticate });
  link.ready().catch(() => undefined);
  return { link, peer: () => peer, closed: () => wire.closed };
}

test("a paired node answers the challenge with its key, negotiates and is served calls", async () => {
  const { nodeId, identity } = pairedNode();
  connectLoopbackNode(state, { nodeId, identity, authenticate });
  try {
    await loopbackLink(state, nodeId).ready();
    expect(state.nodes.get(nodeId).connected).toBe(true);
    expect(await state.nodes.get(nodeId).request("session.close", { sessionId: "none" })).toEqual({ closed: false });
  } finally { await stopLoopbackNode(state, nodeId); }
});

test("an answer recorded on one connection is refused on the next, which is closed; the first stays the link", async () => {
  const { nodeId, identity } = pairedNode();
  let recorded: NodeAnswer | undefined;
  const first = dialRawNode(nodeId, challenge => (recorded = signNodeChallenge(identity, nodeId, challenge)));
  await first.link.ready();
  const replay = dialRawNode(nodeId, () => recorded!);
  await expect(replay.link.ready()).rejects.toThrow();
  await until(replay.closed);
  expect(state.nodes.get(nodeId).connected).toBe(true);
  // The first connection still serves its node's calls.
  await expect(first.peer().call("session.started", { epoch: (await first.link.ready()).epoch, sessionId: "unknown", runId: "r" }, acknowledgedResult))
    .rejects.toMatchObject({ code: APPLICATION_ERROR, message: "Session not found: unknown" });
  first.link.stop();
});

test("the challenge is consumed by the first answer: a second answer on the connection is not accepted", async () => {
  const { nodeId, identity } = pairedNode();
  const [serverEnd, nodeEnd] = createLoopbackPair();
  state.nodes.accept(serverEnd, { authenticate });
  const frames: Array<{ id?: string | number; method?: string; params?: NodeChallenge; result?: unknown }> = [];
  nodeEnd.onmessage = data => frames.push(JSON.parse(data));
  await until(() => frames.length === 1);
  const [challenge] = frames;
  expect(challenge!.method).toBe("node.authenticate");
  const reply = (result: NodeAnswer) => nodeEnd.send(JSON.stringify({ jsonrpc: "2.0", id: challenge!.id, result }));
  reply(signNodeChallenge({ ...identity, privateKey: otherKey() }, nodeId, challenge!.params!));
  reply(signNodeChallenge(identity, nodeId, challenge!.params!));
  nodeEnd.send(JSON.stringify({ jsonrpc: "2.0", id: "hello", method: "node.hello", params: { nodeId: nodeId, minVersion: protocolVersion, maxVersion: protocolVersion, capabilities: [], liveSessions: [] } }));
  await until(() => nodeEnd.closed);
  expect(frames.some(frame => frame.id === "hello" && "result" in frame)).toBe(false);
  expect(state.nodes.get(nodeId).connected).toBe(false);
});

test("a hello for another node than the one the connection authenticated as is refused, even for a paired node", async () => {
  const a = pairedNode();
  const b = pairedNode();
  const impostor = dialRawNode(b.nodeId, challenge => signNodeChallenge(a.identity, a.nodeId, challenge));
  await expect(impostor.link.ready()).rejects.toMatchObject({ code: UNAUTHORIZED });
  expect(state.nodes.get(a.nodeId).connected).toBe(false);
  expect(state.nodes.get(b.nodeId).connected).toBe(false);
});

test("an answer not signed by the node's paired key is refused and the connection closed, logging the node but not the answer", async () => {
  const { nodeId, identity } = pairedNode();
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    const refused = async (claimed: string, sign: (challenge: NodeChallenge) => NodeAnswer) => {
      const seen: Array<NodeChallenge & NodeAnswer> = [];
      const node = dialRawNode(claimed, challenge => { const answer = sign(challenge); seen.push({ ...challenge, ...answer }); return answer; });
      await expect(node.link.ready()).rejects.toThrow();
      await until(node.closed);
      await until(() => warn.mock.calls.some(call => call.join(" ").includes(claimed)));
      const logged = warn.mock.calls.map(call => call.join(" ")).join("\n");
      expect(logged).not.toContain(seen[0]!.nonce);
      expect(logged).not.toContain(seen[0]!.signature);
      expect(state.nodes.get(claimed).connected).toBe(false);
      warn.mockClear();
    };
    await refused(nodeId, challenge => signNodeChallenge({ ...identity, privateKey: otherKey() }, nodeId, challenge));
    await refused(nodeId, challenge => signNodeChallenge({ ...identity, origin: "https://elsewhere.example.test" }, nodeId, challenge));
    await refused("stranger", challenge => signNodeChallenge({ origin: ORIGIN, privateKey: otherKey() }, "stranger", challenge));
    // The seeded node was never paired: it has no key to authenticate with.
    await refused(SEEDED_NODE_ID, challenge => signNodeChallenge({ origin: ORIGIN, privateKey: otherKey() }, SEEDED_NODE_ID, challenge));
  } finally { warn.mockRestore(); }
});

test("a second authenticated connection for a node replaces the first, whose epoch is then refused", async () => {
  const { nodeId, identity } = pairedNode();
  const first = connectScriptedNode(state, nodeId, {}, { identity, authenticate, redial: false });
  const { epoch: firstEpoch } = await first.ready();
  const second = dialRawNode(nodeId, challenge => signNodeChallenge(identity, nodeId, challenge));
  const { epoch } = await second.link.ready();
  await expect(second.peer().call("session.started", { epoch: firstEpoch, sessionId: "unknown", runId: "r" }, acknowledgedResult)).rejects.toMatchObject({ code: UNAUTHORIZED });
  await expect(second.peer().call("session.started", { epoch, sessionId: "unknown", runId: "r" }, acknowledgedResult)).rejects.toMatchObject({ code: APPLICATION_ERROR });
  expect(state.nodes.get(nodeId).connected).toBe(true);
  second.link.stop();
});

test("revoking a node closes its authenticated link; its next connection proves its key but is refused at hello, logged, and never linked", async () => {
  const { nodeId, identity } = pairedNode();
  const link = connectScriptedNode(state, nodeId, {}, { identity, authenticate, redial: false });
  await link.ready();
  new Nodes(state.nodes, () => {}).get(nodeId).revoke();
  await until(() => !state.nodes.get(nodeId).connected);

  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    const again = connectScriptedNode(state, nodeId, {}, { identity, authenticate, redial: false });
    await expect(again.ready()).rejects.toMatchObject({ code: UNAUTHORIZED, message: `Node revoked: ${nodeId}` });
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

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { acknowledgedResult, APPLICATION_ERROR, authenticateParams, authenticateResult, createRpcPeer, protocolVersion, readyResult, signNodeChallenge, UNAUTHORIZED, type NodeAnswer, type NodeChallenge, type NodeIdentity, type LinkSocket } from "@reins/node-protocol";
import { createLoopbackPair } from "@reins/node-protocol/testing";
import { useTestDb } from "../helpers/test-db.js";
import { createServerState } from "../helpers/server-state.js";
import { connectLoopbackNode, connectScriptedNode, dialLoopback, loopbackLink, SEEDED_NODE_ID, stopLoopbackNode } from "../helpers/loopback-node.js";
import { createPairingCode, redeemPairingCode } from "../../models/node-pairing.js";
import { revokeNode } from "../../models/nodes.js";
import { logger } from "../../logger.js";
import type { ServerState } from "../../state.js";

useTestDb();
let state: ServerState;
beforeEach(() => { state = createServerState(); });
afterEach(() => state.nodes.close());

const ORIGIN = "https://reins.example.test";
const authenticate = { origin: ORIGIN };
const until = async (condition: () => boolean) => { for (let i = 0; i < 400 && !condition(); i++) await Bun.sleep(5); expect(condition()).toBe(true); };
const otherKey = () => generateKeyPairSync("ed25519").privateKey;

/** Pairs a node through the real pairing code flow; its identity signs for `ORIGIN`. */
function pairedNode(): NodeIdentity {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const { code } = createPairingCode({});
  const { nodeId } = redeemPairingCode({ code, publicKey: publicKey.export({ format: "jwk" }).x!, hostname: "remote-host" });
  return { nodeId, origin: ORIGIN, privateKey };
}

/** A node end on an authenticating connection that answers the server's challenge with `answer` (any
 * answer, e.g. one recorded on another connection), then says hello as `helloNodeId`. It never closes
 * the connection itself. */
function dialRawNode(helloNodeId: string, answer: (challenge: NodeChallenge) => NodeAnswer) {
  let peer!: ReturnType<typeof createRpcPeer>;
  let wire!: LinkSocket;
  const link = dialLoopback(state, socket => {
    wire = socket;
    const answered = Promise.withResolvers<void>();
    peer = createRpcPeer(socket, {
      "node.authenticate": { params: authenticateParams, result: authenticateResult, handle: async (challenge: NodeChallenge) => { setTimeout(answered.resolve, 0); return answer(challenge); } },
    });
    const ready = answered.promise.then(() => peer.call("node.hello", { nodeId: helloNodeId, minVersion: protocolVersion, maxVersion: protocolVersion, capabilities: [], liveSessions: [] }, readyResult));
    return { receive: peer.receive, close() { answered.reject(new Error("closed")); peer.close(); }, ready };
  }, { redial: false, authenticate });
  link.ready().catch(() => undefined);
  return { link, peer: () => peer, closed: () => wire.closed };
}

test("a paired node answers the challenge with its key, negotiates and is served calls", async () => {
  const identity = pairedNode();
  connectLoopbackNode(state, { nodeId: identity.nodeId, identity, authenticate });
  try {
    await loopbackLink(state, identity.nodeId).ready();
    expect(state.nodes.get(identity.nodeId).connected).toBe(true);
    expect(await state.nodes.get(identity.nodeId).request("session.close", { sessionId: "none" })).toEqual({ closed: false });
  } finally { await stopLoopbackNode(state, identity.nodeId); }
});

test("an answer recorded on one connection is refused on the next, which is closed; the first stays the link", async () => {
  const identity = pairedNode();
  let recorded: NodeAnswer | undefined;
  const first = dialRawNode(identity.nodeId, challenge => (recorded = signNodeChallenge(identity, challenge)));
  await first.link.ready();
  const replay = dialRawNode(identity.nodeId, () => recorded!);
  await expect(replay.link.ready()).rejects.toThrow();
  await until(replay.closed);
  expect(state.nodes.get(identity.nodeId).connected).toBe(true);
  // The first connection still serves its node's calls.
  await expect(first.peer().call("session.started", { epoch: (await first.link.ready()).epoch, sessionId: "unknown", runId: "r" }, acknowledgedResult))
    .rejects.toMatchObject({ code: APPLICATION_ERROR, message: "Session not found: unknown" });
  first.link.stop();
});

test("the challenge is consumed by the first answer: a second answer on the connection is not accepted", async () => {
  const identity = pairedNode();
  const [serverEnd, nodeEnd] = createLoopbackPair();
  state.nodes.accept(serverEnd, { authenticate });
  const frames: Array<{ id?: string | number; method?: string; params?: NodeChallenge; result?: unknown }> = [];
  nodeEnd.onmessage = data => frames.push(JSON.parse(data));
  await until(() => frames.length === 1);
  const [challenge] = frames;
  expect(challenge!.method).toBe("node.authenticate");
  const reply = (result: NodeAnswer) => nodeEnd.send(JSON.stringify({ jsonrpc: "2.0", id: challenge!.id, result }));
  reply(signNodeChallenge({ ...identity, privateKey: otherKey() }, challenge!.params!));
  reply(signNodeChallenge(identity, challenge!.params!));
  nodeEnd.send(JSON.stringify({ jsonrpc: "2.0", id: "hello", method: "node.hello", params: { nodeId: identity.nodeId, minVersion: protocolVersion, maxVersion: protocolVersion, capabilities: [], liveSessions: [] } }));
  await until(() => nodeEnd.closed);
  expect(frames.some(frame => frame.id === "hello" && "result" in frame)).toBe(false);
  expect(state.nodes.get(identity.nodeId).connected).toBe(false);
});

test("a hello for another node than the one the connection authenticated as is refused, even for a paired node", async () => {
  const a = pairedNode();
  const b = pairedNode();
  const impostor = dialRawNode(b.nodeId, challenge => signNodeChallenge(a, challenge));
  await expect(impostor.link.ready()).rejects.toMatchObject({ code: UNAUTHORIZED });
  expect(state.nodes.get(a.nodeId).connected).toBe(false);
  expect(state.nodes.get(b.nodeId).connected).toBe(false);
});

test("an answer not signed by the node's paired key is refused and the connection closed, logging the node but not the answer", async () => {
  const identity = pairedNode();
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    const refused = async (nodeId: string, sign: (challenge: NodeChallenge) => NodeAnswer) => {
      const seen: Array<NodeChallenge & NodeAnswer> = [];
      const node = dialRawNode(nodeId, challenge => { const answer = sign(challenge); seen.push({ ...challenge, ...answer }); return answer; });
      await expect(node.link.ready()).rejects.toThrow();
      await until(node.closed);
      await until(() => warn.mock.calls.some(call => call.join(" ").includes(nodeId)));
      const logged = warn.mock.calls.map(call => call.join(" ")).join("\n");
      expect(logged).not.toContain(seen[0]!.nonce);
      expect(logged).not.toContain(seen[0]!.signature);
      expect(state.nodes.get(nodeId).connected).toBe(false);
      warn.mockClear();
    };
    await refused(identity.nodeId, challenge => signNodeChallenge({ ...identity, privateKey: otherKey() }, challenge));
    await refused(identity.nodeId, challenge => signNodeChallenge({ ...identity, origin: "https://elsewhere.example.test" }, challenge));
    await refused("stranger", challenge => signNodeChallenge({ nodeId: "stranger", origin: ORIGIN, privateKey: otherKey() }, challenge));
    // The seeded node was never paired: it has no key to authenticate with.
    await refused(SEEDED_NODE_ID, challenge => signNodeChallenge({ nodeId: SEEDED_NODE_ID, origin: ORIGIN, privateKey: otherKey() }, challenge));
  } finally { warn.mockRestore(); }
});

test("a second authenticated connection for a node replaces the first, whose epoch is then refused", async () => {
  const identity = pairedNode();
  const first = connectScriptedNode(state, identity.nodeId, {}, { identity, authenticate, redial: false });
  const { epoch: firstEpoch } = await first.ready();
  const second = dialRawNode(identity.nodeId, challenge => signNodeChallenge(identity, challenge));
  const { epoch } = await second.link.ready();
  await expect(second.peer().call("session.started", { epoch: firstEpoch, sessionId: "unknown", runId: "r" }, acknowledgedResult)).rejects.toMatchObject({ code: UNAUTHORIZED });
  await expect(second.peer().call("session.started", { epoch, sessionId: "unknown", runId: "r" }, acknowledgedResult)).rejects.toMatchObject({ code: APPLICATION_ERROR });
  expect(state.nodes.get(identity.nodeId).connected).toBe(true);
  second.link.stop();
});

test("revoking a node closes its authenticated link and its key is refused on its next connection", async () => {
  const identity = pairedNode();
  const link = connectScriptedNode(state, identity.nodeId, {}, { identity, authenticate, redial: false });
  await link.ready();
  revokeNode(state.nodes, identity.nodeId);
  await until(() => !state.nodes.get(identity.nodeId).connected);

  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    const again = connectScriptedNode(state, identity.nodeId, {}, { identity, authenticate, redial: false });
    await expect(again.ready()).rejects.toThrow();
    // Refused at the challenge (logged by the server), not only at hello.
    expect(warn.mock.calls.some(call => call.join(" ").includes(identity.nodeId))).toBe(true);
    expect(state.nodes.get(identity.nodeId).connected).toBe(false);
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

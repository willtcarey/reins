import { describe, test, expect, afterEach, setSystemTime, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { APPLICATION_ERROR, generateNodeKeyPair, RpcFailure, type NodeError, type NodeIdentity } from "@reins/node-protocol";
import { logger } from "../../logger.js";
import { createProject } from "../project-fixture.js";
import type { ServerState } from "../../state.js";
import { buildRouter } from "../../routes/index.js";
import { getDb } from "../../db.js";
import { createPairingCode } from "../../models/node-pairing.js";
import { makeRequest } from "../helpers/request.js";
import { createServerState } from "../helpers/server-state.js";
import { useTestDb } from "../helpers/test-db.js";
import { connectScriptedNode, SEEDED_NODE_ID } from "../helpers/loopback-node.js";

/** A fresh Ed25519 public key as a node sends it: base64url of the raw 32 bytes. */
const newPublicKey = () => generateNodeKeyPair().publicKey;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const grants = () => getDb().query("SELECT * FROM node_pairing_grants ORDER BY id").all();
const pairedNodes = () => getDb().query("SELECT * FROM nodes WHERE id != 'internal' ORDER BY name").all();
const INVALID_CODE = { error: "Invalid or expired pairing code" };

describe("node pairing", () => {
  useTestDb();
  afterEach(() => { setSystemTime(); });
  const router = buildRouter();
  const post = async (path: string, body?: unknown) => {
    const res = (await router.handle(makeRequest("POST", path, body), createServerState()))!;
    return { status: res.status, body: await res.json() };
  };
  const createCode = async (body: { name?: string } = {}): Promise<{ id: number; code: string; expiresAt: string }> => (await post("/api/nodes/pairing-codes", body)).body;

  test("a pairing code is 32 random bytes valid for 10 minutes, of which only the hash is stored", async () => {
    setSystemTime(new Date("2026-10-08T12:00:00.000Z"));

    const created = await post("/api/nodes/pairing-codes", { name: "Laptop" });

    expect(created).toEqual({ status: 201, body: { id: 1, code: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), expiresAt: "2026-10-08T12:10:00.000Z" } });
    expect(grants()).toEqual([{ id: 1, code_sha256: sha256(created.body.code), name: "Laptop", created_at: "2026-10-08T12:00:00.000Z", expires_at: "2026-10-08T12:10:00.000Z", consumed_at: null, node_id: null }]);
  });

  test("a pairing code never starts with -, which a command line would read as an option", () => {
    // One base64url code in 64 would; 2000 of them all missing it by chance is about 1 in 10^13.
    const codes = Array.from({ length: 2000 }, () => createPairingCode({}).code);

    expect(codes.filter(code => code.startsWith("-"))).toEqual([]);
    expect(codes.every(code => /^[A-Za-z0-9_-]{43}$/.test(code))).toBe(true);
  });

  test("redeeming a code pairs a new node bound to the public key, named as the code says, and consumes the code", async () => {
    setSystemTime(new Date("2026-10-08T12:00:00.000Z"));
    const { code } = await createCode({ name: "Laptop" });
    const publicKey = newPublicKey();
    setSystemTime(new Date("2026-10-08T12:05:00.000Z"));

    const paired = await post("/api/nodes/pair", { code, publicKey, hostname: "will-mbp" });

    expect(paired).toEqual({ status: 201, body: { nodeId: expect.stringMatching(/^[0-9a-f-]{36}$/), name: "Laptop" } });
    const nodeId: string = paired.body.nodeId;
    expect(pairedNodes()).toEqual([{ id: nodeId, name: "Laptop", public_key: publicKey, hostname: "will-mbp", paired_at: "2026-10-08T12:05:00.000Z", revoked_at: null }]);
    expect(grants()).toEqual([expect.objectContaining({ consumed_at: "2026-10-08T12:05:00.000Z", node_id: nodeId })]);
    const listed = await router.handle(makeRequest("GET", "/api/nodes"), createServerState());
    expect(await listed!.json()).toEqual([
      { id: SEEDED_NODE_ID, name: "Internal", connected: false, paired: false, hostname: null, pairedAt: null, revokedAt: null },
      { id: nodeId, name: "Laptop", connected: false, paired: true, hostname: "will-mbp", pairedAt: "2026-10-08T12:05:00.000Z", revokedAt: null },
    ]);
  });

  test("a code with no name names the node after its hostname", async () => {
    const { code } = await createCode();

    expect((await post("/api/nodes/pair", { code, publicKey: newPublicKey(), hostname: "build-box" })).body).toMatchObject({ name: "build-box" });
    expect(pairedNodes()).toEqual([expect.objectContaining({ name: "build-box", hostname: "build-box" })]);
  });

  test("a code read from the database, i.e. its hash, does not redeem", async () => {
    await createCode();
    const before = grants();
    const { code_sha256 } = getDb().query<{ code_sha256: string }, []>("SELECT code_sha256 FROM node_pairing_grants").get()!;

    expect(await post("/api/nodes/pair", { code: code_sha256, publicKey: newPublicKey(), hostname: "thief" })).toEqual({ status: 403, body: INVALID_CODE });
    expect(pairedNodes()).toEqual([]);
    expect(grants()).toEqual(before);
  });

  test("a used code does not redeem again, rebind its node's key or create a node", async () => {
    const { code } = await createCode();
    await post("/api/nodes/pair", { code, publicKey: newPublicKey(), hostname: "first" });
    const nodes = pairedNodes();
    const used = grants();

    expect(await post("/api/nodes/pair", { code, publicKey: newPublicKey(), hostname: "second" })).toEqual({ status: 403, body: INVALID_CODE });
    expect(pairedNodes()).toEqual(nodes);
    expect(grants()).toEqual(used);
  });

  test("an expired code is refused", async () => {
    setSystemTime(new Date("2026-10-08T12:00:00.000Z"));
    const { code } = await createCode();
    const before = grants();
    setSystemTime(new Date("2026-10-08T12:10:00.000Z"));

    expect(await post("/api/nodes/pair", { code, publicKey: newPublicKey(), hostname: "late" })).toEqual({ status: 403, body: INVALID_CODE });
    expect(pairedNodes()).toEqual([]);
    expect(grants()).toEqual(before);
  });

  test("competing redemptions of one code have exactly one winner", async () => {
    const { code } = await createCode();
    const keys = [newPublicKey(), newPublicKey()];

    const results = await Promise.all(keys.map((publicKey, i) => post("/api/nodes/pair", { code, publicKey, hostname: `racer-${i}` })));

    expect(results.map(result => result.status).toSorted()).toEqual([201, 403]);
    const winner = results.findIndex(result => result.status === 201);
    expect(pairedNodes()).toEqual([expect.objectContaining({ id: results[winner]!.body.nodeId, public_key: keys[winner] })]);
  });

  test("a malformed body or public key is refused (400) and leaves the code unused", async () => {
    const { code } = await createCode();
    const before = grants();
    const raw = Buffer.from(newPublicKey(), "base64url");
    const malformed = [
      { code, publicKey: "not a key", hostname: "h" },
      { code, publicKey: raw.subarray(0, 31).toString("base64url"), hostname: "h" },
      { code, publicKey: raw.toString("base64").replace(/=+$/, "") + "==", hostname: "h" },
      { code, publicKey: newPublicKey() },
    ];

    for (const body of malformed) {
      const refused = await post("/api/nodes/pair", body);
      expect(refused.status).toBe(400);
      expect(JSON.stringify(refused.body)).not.toContain(code);
    }
    expect(pairedNodes()).toEqual([]);
    expect(grants()).toEqual(before);
    expect((await post("/api/nodes/pair", { code, publicKey: newPublicKey(), hostname: "h" })).status).toBe(201);
  });

  test("a public key already bound to a node is refused (409) and leaves the code unused", async () => {
    const publicKey = newPublicKey();
    await post("/api/nodes/pair", { code: (await createCode()).code, publicKey, hostname: "first" });
    const { code } = await createCode();
    const nodes = pairedNodes();

    expect((await post("/api/nodes/pair", { code, publicKey, hostname: "again" })).status).toBe(409);
    expect(pairedNodes()).toEqual(nodes);
    expect(grants()).toEqual([expect.objectContaining({ consumed_at: expect.any(String) }), expect.objectContaining({ consumed_at: null, node_id: null })]);
  });
});

describe("POST /api/nodes/:nodeId/revoke", () => {
  useTestDb();
  afterEach(() => { setSystemTime(); });
  const router = buildRouter();

  test("revoking a paired node records when, closes its link and refuses its later hellos; revoking again changes nothing", async () => {
    const state = createServerState();
    const code = (await (await router.handle(makeRequest("POST", "/api/nodes/pairing-codes", {}), state))!.json()).code;
    const { nodeId } = await (await router.handle(makeRequest("POST", "/api/nodes/pair", { code, publicKey: newPublicKey(), hostname: "box" }), state))!.json();
    const link = connectScriptedNode(state, nodeId, {});
    try {
      await link.ready();
      expect(state.nodes.get(nodeId).connected).toBe(true);
      setSystemTime(new Date("2026-10-08T13:00:00.000Z"));

      const revoked = await router.handle(makeRequest("POST", `/api/nodes/${nodeId}/revoke`), state);

      expect(revoked!.status).toBe(200);
      expect(await revoked!.json()).toMatchObject({ id: nodeId, connected: false, paired: true, revokedAt: "2026-10-08T13:00:00.000Z" });
      expect(getDb().query("SELECT revoked_at FROM nodes WHERE id = ?").get(nodeId)).toEqual({ revoked_at: "2026-10-08T13:00:00.000Z" });
      const redial = connectScriptedNode(state, nodeId, {});
      await expect(redial.ready()).rejects.toMatchObject({ message: `Node revoked: ${nodeId}` });
      expect(state.nodes.get(nodeId).connected).toBe(false);

      setSystemTime(new Date("2026-10-08T14:00:00.000Z"));
      const again = await router.handle(makeRequest("POST", `/api/nodes/${nodeId}/revoke`), state);
      expect(await again!.json()).toMatchObject({ revokedAt: "2026-10-08T13:00:00.000Z" });
    } finally { link.stop(); state.nodes.close(); }
  });

  test("the never-paired local node cannot be revoked (409); an unknown node is 404", async () => {
    const state = createServerState();

    expect((await router.handle(makeRequest("POST", `/api/nodes/${SEEDED_NODE_ID}/revoke`), state))!.status).toBe(409);
    expect(getDb().query("SELECT revoked_at FROM nodes WHERE id = ?").get(SEEDED_NODE_ID)).toEqual({ revoked_at: null });
    expect((await router.handle(makeRequest("POST", "/api/nodes/nowhere/revoke"), state))!.status).toBe(404);
    state.nodes.close();
  });
});

describe("DELETE /api/nodes/:nodeId", () => {
  useTestDb();
  const router = buildRouter();
  const ORIGIN = "https://reins.example.test";

  /** Pairs a node through the routes with a fresh key; its identity signs for `ORIGIN`. */
  async function pairNode(state: ServerState, name = "Laptop"): Promise<{ nodeId: string; identity: NodeIdentity }> {
    const { publicKey, privateKey } = generateNodeKeyPair();
    const { code } = await (await router.handle(makeRequest("POST", "/api/nodes/pairing-codes", { name }), state))!.json();
    const { nodeId } = await (await router.handle(makeRequest("POST", "/api/nodes/pair", { code, publicKey, hostname: "box" }), state))!.json();
    return { nodeId, identity: { origin: ORIGIN, privateKey } };
  }

  test("removing a paired node closes its link and deletes it, so its key is refused from then on", async () => {
    const state = createServerState();
    const { nodeId, identity } = await pairNode(state);
    const link = connectScriptedNode(state, nodeId, {}, { identity, authenticate: { origin: ORIGIN }, redial: false });
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await link.ready();

      const removed = await router.handle(makeRequest("DELETE", `/api/nodes/${nodeId}`), state);

      expect(removed!.status).toBe(204);
      expect(state.nodes.get(nodeId).connected).toBe(false);
      expect(getDb().query("SELECT id FROM nodes").all()).toEqual([{ id: SEEDED_NODE_ID }]);
      expect(getDb().query("SELECT node_id FROM node_pairing_grants").all()).toEqual([{ node_id: null }]);
      const redial = connectScriptedNode(state, nodeId, {}, { identity, authenticate: { origin: ORIGIN }, redial: false });
      await expect(redial.ready()).rejects.toThrow();
      expect(state.nodes.get(nodeId).connected).toBe(false);
    } finally { warn.mockRestore(); link.stop(); await state.nodes.close(); }
  });

  test("a revoked node can be removed", async () => {
    const state = createServerState();
    const { nodeId } = await pairNode(state);
    await router.handle(makeRequest("POST", `/api/nodes/${nodeId}/revoke`), state);

    expect((await router.handle(makeRequest("DELETE", `/api/nodes/${nodeId}`), state))!.status).toBe(204);
    expect(getDb().query("SELECT id FROM nodes WHERE id = ?").get(nodeId)).toBeNull();
    await state.nodes.close();
  });

  test("a node that still holds project sources is not removed (409), naming the projects", async () => {
    const state = createServerState();
    const { nodeId } = await pairNode(state);
    createProject("Website", "/srv/website", "main", nodeId);
    createProject("Api", "/srv/api", "main", nodeId);

    const refused = await router.handle(makeRequest("DELETE", `/api/nodes/${nodeId}`), state);

    expect(refused!.status).toBe(409);
    expect(await refused!.json()).toEqual({ error: "Laptop still holds sources of these projects: Api, Website" });
    expect(getDb().query("SELECT id FROM nodes WHERE id = ?").get(nodeId)).toEqual({ id: nodeId });
    expect(getDb().query("SELECT COUNT(*) AS n FROM sources WHERE node_id = ?").get(nodeId)).toEqual({ n: 2 });
    await state.nodes.close();
  });

  test("the never-paired local node cannot be removed (409); an unknown node is 404", async () => {
    const state = createServerState();

    expect((await router.handle(makeRequest("DELETE", `/api/nodes/${SEEDED_NODE_ID}`), state))!.status).toBe(409);
    expect(getDb().query("SELECT id FROM nodes").all()).toEqual([{ id: SEEDED_NODE_ID }]);
    expect((await router.handle(makeRequest("DELETE", "/api/nodes/nowhere"), state))!.status).toBe(404);
    await state.nodes.close();
  });
});

describe("node events reach browsers", () => {
  useTestDb();
  afterEach(() => { setSystemTime(); });
  const router = buildRouter();
  const until = async (condition: () => boolean) => { for (let i = 0; i < 400 && !condition(); i++) await Bun.sleep(5); expect(condition()).toBe(true); };

  /** A server state with one browser connected, recording what it receives. */
  function withBrowser() {
    const received: Array<Record<string, unknown>> = [];
    const state = createServerState({ clients: new Set([{ ws: { send: data => { received.push(JSON.parse(data)); return 0; } } }]) });
    return { state, received };
  }

  test("redeeming a code tells browsers which code paired which node", async () => {
    const { state, received } = withBrowser();
    setSystemTime(new Date("2026-10-08T12:00:00.000Z"));
    const { id, code } = await (await router.handle(makeRequest("POST", "/api/nodes/pairing-codes", { name: "Laptop" }), state))!.json();

    const { nodeId } = await (await router.handle(makeRequest("POST", "/api/nodes/pair", { code, publicKey: newPublicKey(), hostname: "box" }), state))!.json();

    expect(received).toEqual([{
      type: "node_paired",
      pairingCodeId: id,
      node: { id: nodeId, name: "Laptop", connected: false, paired: true, hostname: "box", pairedAt: "2026-10-08T12:00:00.000Z", revokedAt: null },
    }]);
    await state.nodes.close();
  });

  test("a node connecting and disconnecting updates it in browsers", async () => {
    const { state, received } = withBrowser();
    const link = connectScriptedNode(state, SEEDED_NODE_ID, {}, { redial: false });
    const local = { id: SEEDED_NODE_ID, name: "Internal", paired: false, hostname: null, pairedAt: null, revokedAt: null };
    try {
      await link.ready();
      await until(() => received.length === 1);
      expect(received).toEqual([{ type: "node_updated", node: { ...local, connected: true } }]);

      link.stop();

      await until(() => received.length === 2);
      expect(received[1]).toEqual({ type: "node_updated", node: { ...local, connected: false } });
    } finally { link.stop(); await state.nodes.close(); }
  });

  test("revoking a node updates it in browsers", async () => {
    const { state, received } = withBrowser();
    const { code } = await (await router.handle(makeRequest("POST", "/api/nodes/pairing-codes", {}), state))!.json();
    const { nodeId } = await (await router.handle(makeRequest("POST", "/api/nodes/pair", { code, publicKey: newPublicKey(), hostname: "box" }), state))!.json();
    received.length = 0;
    setSystemTime(new Date("2026-10-08T13:00:00.000Z"));

    await router.handle(makeRequest("POST", `/api/nodes/${nodeId}/revoke`), state);

    expect(received).toEqual([{ type: "node_updated", node: expect.objectContaining({ id: nodeId, connected: false, revokedAt: "2026-10-08T13:00:00.000Z" }) }]);
    await state.nodes.close();
  });

  test("removing a node removes it in browsers", async () => {
    const { state, received } = withBrowser();
    const { code } = await (await router.handle(makeRequest("POST", "/api/nodes/pairing-codes", {}), state))!.json();
    const { nodeId } = await (await router.handle(makeRequest("POST", "/api/nodes/pair", { code, publicKey: newPublicKey(), hostname: "box" }), state))!.json();
    received.length = 0;

    await router.handle(makeRequest("DELETE", `/api/nodes/${nodeId}`), state);

    expect(received).toEqual([{ type: "node_removed", nodeId }]);
    await state.nodes.close();
  });
});

describe("POST /api/nodes/:nodeId/reload", () => {
  useTestDb();
  const router = buildRouter();

  test("asks the node to reload and answers once it is scheduled; force is passed on, and a body is optional", async () => {
    const state = createServerState();
    const requests: unknown[] = [];
    const link = connectScriptedNode(state, SEEDED_NODE_ID, { reload: async input => { requests.push(input); return { scheduled: true }; } });
    try {
      await link.ready();
      const forced = await router.handle(makeRequest("POST", `/api/nodes/${SEEDED_NODE_ID}/reload`, { force: true }), state);
      expect(forced!.status).toBe(200);
      expect(await forced!.json()).toEqual({ scheduled: true });
      const plain = await router.handle(makeRequest("POST", `/api/nodes/${SEEDED_NODE_ID}/reload`), state);
      expect(plain!.status).toBe(200);
      expect(requests).toEqual([{ force: true }, { force: false }]);
    } finally { link.stop(); state.nodes.close(); }
  });

  test("answers 409 with the node's refusal, 503 when the node is not connected and 404 for an unknown node", async () => {
    const state = createServerState();
    const offline = await router.handle(makeRequest("POST", `/api/nodes/${SEEDED_NODE_ID}/reload`), state);
    expect(offline!.status).toBe(503);
    expect(await router.handle(makeRequest("POST", "/api/nodes/nowhere/reload"), state).then(res => res!.status)).toBe(404);

    const refusal = "The node's new code does not build: Unexpected token";
    const link = connectScriptedNode(state, SEEDED_NODE_ID, { reload: async () => {
      throw new RpcFailure(APPLICATION_ERROR, refusal, undefined, { code: "invalid_request", message: refusal, retryable: false } satisfies NodeError);
    } });
    try {
      await link.ready();
      const refused = await router.handle(makeRequest("POST", `/api/nodes/${SEEDED_NODE_ID}/reload`), state);
      expect(refused!.status).toBe(409);
      expect(await refused!.json()).toEqual({ error: refusal });
    } finally { link.stop(); state.nodes.close(); }
  });
});

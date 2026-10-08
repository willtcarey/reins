import { describe, test, expect, afterEach, setSystemTime } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { APPLICATION_ERROR, RpcFailure, type NodeError } from "@reins/node-protocol";
import { buildRouter } from "../../routes/index.js";
import { getDb } from "../../db.js";
import { makeRequest } from "../helpers/request.js";
import { createServerState } from "../helpers/server-state.js";
import { useTestDb } from "../helpers/test-db.js";
import { connectScriptedNode, SEEDED_NODE_ID } from "../helpers/loopback-node.js";

/** A fresh Ed25519 public key as a node sends it: base64url of the raw 32 bytes. */
const newPublicKey = () => generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }).x!;
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
  const createCode = async (body: { name?: string } = {}): Promise<{ code: string; expiresAt: string }> => (await post("/api/nodes/pairing-codes", body)).body;

  test("a pairing code is 32 random bytes valid for 10 minutes, of which only the hash is stored", async () => {
    setSystemTime(new Date("2026-10-08T12:00:00.000Z"));

    const created = await post("/api/nodes/pairing-codes", { name: "Laptop" });

    expect(created).toEqual({ status: 201, body: { code: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), expiresAt: "2026-10-08T12:10:00.000Z" } });
    expect(grants()).toEqual([{ id: 1, code_sha256: sha256(created.body.code), name: "Laptop", created_at: "2026-10-08T12:00:00.000Z", expires_at: "2026-10-08T12:10:00.000Z", consumed_at: null, node_id: null }]);
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

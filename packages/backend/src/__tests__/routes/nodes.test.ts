import { describe, test, expect, afterEach, setSystemTime, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { generateNodeKeyPair, NodeRejection, type NodeKey } from "@reins/node-protocol";
import { logger } from "../../logger.js";
import { createProject } from "../project-fixture.js";
import type { ServerState } from "../../state.js";
import { buildRouter } from "../../routes/index.js";
import { getDb } from "../../db.js";
import { Nodes } from "../../models/nodes.js";
import type { NodeView } from "../../models/node.js";
import { createSource, defaultSource } from "../../node-store.js";
import { createSession, getSession } from "../session-fixture.js";
import { Sessions } from "../../models/sessions.js";
import { latestSettlement } from "../../sessions/session-runs.js";
import { fakeModel } from "../helpers/fake-model.js";
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

  test("a pairing code never starts with -, which a command line would read as an option", async () => {
    const state = createServerState();
    const pairing = new Nodes(state, () => {}).pairing();
    // One base64url code in 64 would; 2000 of them all missing it by chance is about 1 in 10^13.
    const codes = Array.from({ length: 2000 }, () => pairing.createCode().code);
    await state.nodes.close();

    expect(codes.filter(code => code.startsWith("-"))).toEqual([]);
    expect(codes.every(code => /^[A-Za-z0-9_-]{43}$/.test(code))).toBe(true);
  });

  test("redeeming a code pairs a new node bound to the public key, named as the code says, and consumes the code; the node's view says it is paired but never carries the key", async () => {
    setSystemTime(new Date("2026-10-08T12:00:00.000Z"));
    const { code } = await createCode({ name: "Laptop" });
    const publicKey = newPublicKey();
    setSystemTime(new Date("2026-10-08T12:05:00.000Z"));

    const paired = await post("/api/nodes/pair", { code, publicKey, hostname: "will-mbp" });

    expect(paired).toEqual({ status: 201, body: { nodeId: expect.stringMatching(/^[0-9a-f-]{36}$/), name: "Laptop" } });
    const nodeId: string = paired.body.nodeId;
    expect(pairedNodes()).toEqual([{ id: nodeId, name: "Laptop", public_key: publicKey, hostname: "will-mbp", paired_at: "2026-10-08T12:05:00.000Z", revoked_at: null, removed_at: null }]);
    expect(grants()).toEqual([expect.objectContaining({ consumed_at: "2026-10-08T12:05:00.000Z", node_id: nodeId })]);
    const listed = await (await router.handle(makeRequest("GET", "/api/nodes"), createServerState()))!.json();
    expect(listed).toEqual([
      { id: SEEDED_NODE_ID, name: "Internal", connected: false, paired: false, hostname: null, pairedAt: null, revokedAt: null, sources: [], build: null },
      { id: nodeId, name: "Laptop", connected: false, paired: true, hostname: "will-mbp", pairedAt: "2026-10-08T12:05:00.000Z", revokedAt: null, sources: [], build: null },
    ]);
    expect(JSON.stringify(listed)).not.toContain(publicKey);
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

  /** Pairs a node through the routes with a fresh key, which signs for `ORIGIN`. */
  async function pairNode(state: ServerState, name = "Laptop"): Promise<{ nodeId: string; key: NodeKey }> {
    const { publicKey, privateKey } = generateNodeKeyPair();
    const { code } = await (await router.handle(makeRequest("POST", "/api/nodes/pairing-codes", { name }), state))!.json();
    const { nodeId } = await (await router.handle(makeRequest("POST", "/api/nodes/pair", { code, publicKey, hostname: "box" }), state))!.json();
    return { nodeId, key: { origin: ORIGIN, privateKey } };
  }

  test("removing a node holding sources abandons it: its link closes, it is no longer listed, and its hello is refused from then on; its sources and pairing grant stay", async () => {
    const state = createServerState();
    const { nodeId, key } = await pairNode(state);
    createProject("Website", "/srv/website", "main", nodeId);
    const link = connectScriptedNode(state, nodeId, {}, { key, authenticate: { origin: ORIGIN }, redial: false });
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await link.ready();
      setSystemTime(new Date("2026-10-11T09:00:00.000Z"));

      const removed = await router.handle(makeRequest("DELETE", `/api/nodes/${nodeId}`), state);
      setSystemTime();

      expect(removed!.status).toBe(204);
      expect(state.nodes.get(nodeId).connected).toBe(false);
      expect(getDb().query("SELECT id, removed_at FROM nodes WHERE id = ?").get(nodeId)).toEqual({ id: nodeId, removed_at: "2026-10-11T09:00:00.000Z" });
      expect(getDb().query("SELECT node_id, path FROM sources WHERE node_id = ?").all(nodeId)).toEqual([{ node_id: nodeId, path: "/srv/website" }]);
      expect(getDb().query("SELECT node_id FROM node_pairing_grants").all()).toEqual([{ node_id: nodeId }]);
      const listed: NodeView[] = await (await router.handle(makeRequest("GET", "/api/nodes"), state))!.json();
      expect(listed.map(node => node.id)).toEqual([SEEDED_NODE_ID]);
      const redial = connectScriptedNode(state, nodeId, {}, { key, authenticate: { origin: ORIGIN }, redial: false });
      await expect(redial.ready()).rejects.toMatchObject({ reason: "refused", message: `Node removed: ${nodeId}` });
      expect(state.nodes.get(nodeId).connected).toBe(false);
    } finally { setSystemTime(); warn.mockRestore(); link.stop(); await state.nodes.close(); }
  });

  test("a run in progress on a node when it is removed ends as interrupted, so its session can move to another node", async () => {
    const state = createServerState();
    const { nodeId } = await pairNode(state);
    const project = createProject("Website", "/srv/website", "main", nodeId);
    createSource(project.id, SEEDED_NODE_ID, "/home/me/website");
    createSession("running", project.id, { agentRuntimeType: "pi", sourceId: defaultSource(project.id)!.id });
    getDb().exec("UPDATE sessions SET activity_state = 'running', run_id = 'run-1' WHERE id = 'running'");
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await router.handle(makeRequest("DELETE", `/api/nodes/${nodeId}`), state);
    } finally { warn.mockRestore(); }

    expect(getDb().query("SELECT activity_state, run_id, settlement_json FROM sessions WHERE id = 'running'").get()).toEqual({
      activity_state: "finished", run_id: null, settlement_json: JSON.stringify({ status: "failed", error: { message: "The run was interrupted: its node was removed" } }),
    });
    const moved = await router.handle(makeRequest("POST", "/api/sessions/running/move", { nodeId: SEEDED_NODE_ID }), state);
    expect(moved!.status).toBe(200);
    await state.nodes.close();
  });

  test("removing a node aborts the runs of its sessions' live runtimes, a run waiting for the node included, and closes them", async () => {
    const model = fakeModel();
    const state = createServerState();
    const { nodeId } = await pairNode(state);
    const project = createProject("Website", "/srv/website", "main", nodeId);
    createSession("live", project.id, { agentRuntimeType: "pi", sourceId: defaultSource(project.id)!.id, modelProvider: model.model.provider, modelId: model.model.modelId });
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      // The node is offline: the run waits for it at its first request (its checkout).
      await new Sessions(state, () => {}).submit("live", { op: "prompt", content: [{ type: "text", text: "Work" }], clientId: "work" });
      for (let i = 0; i < 200 && getSession("live")?.activity_state !== "running"; i++) await Bun.sleep(5);
      expect(getSession("live")?.activity_state).toBe("running");

      expect((await router.handle(makeRequest("DELETE", `/api/nodes/${nodeId}`), state))!.status).toBe(204);
      expect(state.sessions.live.has("live")).toBe(false);
      expect(latestSettlement("live")).toMatchObject({ status: "aborted" });
      expect(getSession("live")?.activity_state).not.toBe("running");
      expect(model.turns).toEqual([]);
    } finally { warn.mockRestore(); model.dispose(); await state.nodes.close(); }
  });

  test("removing a node again changes nothing; a removed node cannot be renamed or revoked (404)", async () => {
    const state = createServerState();
    const { nodeId } = await pairNode(state);
    setSystemTime(new Date("2026-10-11T09:00:00.000Z"));
    await router.handle(makeRequest("DELETE", `/api/nodes/${nodeId}`), state);
    setSystemTime(new Date("2026-10-11T10:00:00.000Z"));

    expect((await router.handle(makeRequest("DELETE", `/api/nodes/${nodeId}`), state))!.status).toBe(204);
    const renamed = await router.handle(makeRequest("PATCH", `/api/nodes/${nodeId}`, { name: "Back" }), state);
    expect({ status: renamed!.status, body: await renamed!.json() }).toEqual({ status: 404, body: { error: `Node removed: ${nodeId}` } });
    expect((await router.handle(makeRequest("POST", `/api/nodes/${nodeId}/revoke`), state))!.status).toBe(404);
    expect(getDb().query("SELECT name, revoked_at, removed_at FROM nodes WHERE id = ?").get(nodeId))
      .toEqual({ name: "Laptop", revoked_at: null, removed_at: "2026-10-11T09:00:00.000Z" });
    setSystemTime();
    await state.nodes.close();
  });

  test("a revoked node can be removed", async () => {
    const state = createServerState();
    const { nodeId } = await pairNode(state);
    await router.handle(makeRequest("POST", `/api/nodes/${nodeId}/revoke`), state);

    expect((await router.handle(makeRequest("DELETE", `/api/nodes/${nodeId}`), state))!.status).toBe(204);
    expect(getDb().query("SELECT removed_at IS NOT NULL AS removed FROM nodes WHERE id = ?").get(nodeId)).toEqual({ removed: 1 });
    await state.nodes.close();
  });

  test("the never-paired local node cannot be removed (409); an unknown node is 404", async () => {
    const state = createServerState();

    expect((await router.handle(makeRequest("DELETE", `/api/nodes/${SEEDED_NODE_ID}`), state))!.status).toBe(409);
    expect(getDb().query("SELECT id, removed_at FROM nodes").all()).toEqual([{ id: SEEDED_NODE_ID, removed_at: null }]);
    expect((await router.handle(makeRequest("DELETE", "/api/nodes/nowhere"), state))!.status).toBe(404);
    await state.nodes.close();
  });
});

describe("PATCH /api/nodes/:nodeId", () => {
  useTestDb();
  const router = buildRouter();

  test("renames a node, the local one included, trimmed, and tells browsers", async () => {
    const received: Array<Record<string, unknown>> = [];
    const state = createServerState({ clients: new Set([{ ws: { send: data => { received.push(JSON.parse(data)); return 0; } } }]) });

    const renamed = await router.handle(makeRequest("PATCH", `/api/nodes/${SEEDED_NODE_ID}`, { name: "  beepboop  " }), state);

    const local = { id: SEEDED_NODE_ID, name: "beepboop", connected: false, paired: false, hostname: null, pairedAt: null, revokedAt: null, sources: [], build: null };
    expect(renamed!.status).toBe(200);
    expect(await renamed!.json()).toEqual(local);
    expect(getDb().query("SELECT name FROM nodes WHERE id = ?").get(SEEDED_NODE_ID)).toEqual({ name: "beepboop" });
    expect(received).toEqual([{ type: "node_updated", node: local }]);
    await state.nodes.close();
  });

  test("a blank or overlong name is refused (400) and an unknown node is 404, renaming nothing", async () => {
    const state = createServerState();

    for (const body of [{ name: "   " }, { name: "x".repeat(101) }, {}]) {
      expect({ body, status: (await router.handle(makeRequest("PATCH", `/api/nodes/${SEEDED_NODE_ID}`, body), state))!.status }).toEqual({ body, status: 400 });
    }
    expect((await router.handle(makeRequest("PATCH", "/api/nodes/nowhere", { name: "Box" }), state))!.status).toBe(404);
    expect(getDb().query("SELECT id, name FROM nodes").all()).toEqual([{ id: SEEDED_NODE_ID, name: "Internal" }]);
    await state.nodes.close();
  });
});

describe("a node's sources", () => {
  useTestDb();
  const router = buildRouter();

  test("each node lists its projects' sources on it, also while it is offline", async () => {
    const state = createServerState();
    getDb().exec("INSERT INTO nodes (id, name) VALUES ('remote', 'Remote')");
    const website = createProject("Website", "/srv/website", "main", "remote");
    const api = createProject("Api", "/srv/api", "main", "remote");
    const local = createProject("Local", "/home/me/local");

    const nodes: NodeView[] = await (await router.handle(makeRequest("GET", "/api/nodes"), state))!.json();

    const sourceId = (projectId: number) => defaultSource(projectId)!.id;
    expect(Object.fromEntries(nodes.map(node => [node.id, node.sources]))).toEqual({
      remote: [
        { path: "/srv/api", project: { id: api.id, name: "Api", sourceId: sourceId(api.id) } },
        { path: "/srv/website", project: { id: website.id, name: "Website", sourceId: sourceId(website.id) } },
      ],
      [SEEDED_NODE_ID]: [{ path: "/home/me/local", project: { id: local.id, name: "Local", sourceId: sourceId(local.id) } }],
    });
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

  test("redeeming a code tells browsers the new node and which code paired it, without its key", async () => {
    const { state, received } = withBrowser();
    setSystemTime(new Date("2026-10-08T12:00:00.000Z"));
    const { id, code } = await (await router.handle(makeRequest("POST", "/api/nodes/pairing-codes", { name: "Laptop" }), state))!.json();
    const publicKey = newPublicKey();

    const { nodeId } = await (await router.handle(makeRequest("POST", "/api/nodes/pair", { code, publicKey, hostname: "box" }), state))!.json();

    expect(received).toEqual([{
      type: "node_updated",
      pairingCodeId: id,
      node: { id: nodeId, name: "Laptop", connected: false, paired: true, hostname: "box", pairedAt: "2026-10-08T12:00:00.000Z", revokedAt: null, sources: [], build: null },
    }]);
    expect(JSON.stringify(received)).not.toContain(publicKey);
    await state.nodes.close();
  });

  test("a node connecting and losing its only link updates it in browsers; a link replacing another does not", async () => {
    const { state, received } = withBrowser();
    const first = connectScriptedNode(state, SEEDED_NODE_ID, {}, { redial: false });
    const local = { id: SEEDED_NODE_ID, name: "Internal", paired: false, hostname: null, pairedAt: null, revokedAt: null, sources: [], build: null };
    let second: ReturnType<typeof connectScriptedNode> | undefined;
    try {
      await first.ready();
      await until(() => received.length === 1);
      expect(received).toEqual([{ type: "node_updated", node: { ...local, connected: true } }]);

      second = connectScriptedNode(state, SEEDED_NODE_ID, {}, { redial: false });
      await second.ready();
      first.stop();
      await Bun.sleep(20);
      expect(received).toHaveLength(1);

      second.stop();

      await until(() => received.length === 2);
      expect(received[1]).toEqual({ type: "node_updated", node: { ...local, connected: false } });
    } finally { first.stop(); second?.stop(); await state.nodes.close(); }
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
      throw new NodeRejection("invalid_request", refusal);
    } });
    try {
      await link.ready();
      const refused = await router.handle(makeRequest("POST", `/api/nodes/${SEEDED_NODE_ID}/reload`), state);
      expect(refused!.status).toBe(409);
      expect(await refused!.json()).toEqual({ error: refusal });
    } finally { link.stop(); state.nodes.close(); }
  });
});

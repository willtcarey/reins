import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT, setValue, value } from "@earendil-works/pi-agent-core";
import { insertEntry } from "@earendil-works/pi-agent-core/harness/session";
import { bindNodeSession, initializeNodeStorage, nodeSessionBinding, nodeSessionTask, openNodeStorage, setNodeDb } from "./storage.js";
import { piSnapshotSummary, readPiSnapshotPage, samePiSnapshot } from "./pi-storage.js";
import { holdsHydratedCopy, hydrateNodeSession, type RelocationServer } from "./relocation.js";
import { APPLICATION_ERROR } from "./protocol/errors.js";
import { RpcFailure } from "./protocol/peer.js";
import { startNode, type NodeServer } from "./node.js";

const binding = { sourceId: 1, cwd: "/tmp/relocation", createdAt: "2026-01-01", parentSessionId: null };
const task = { title: "Task", description: null, branchName: "task/relocation" };
const bytes = new Uint8Array([1, 2, 3]);
const sha256 = createHash("sha256").update(bytes).digest("hex");

/** A server copy of session "s" whose first entry references attachment "att_1". */
async function serverCopy() {
  const server = new Database(":memory:");
  initializeNodeStorage(server);
  bindNodeSession(server, "s", binding);
  const storage = await openNodeStorage(server, "s", async () => {}, () => 42);
  await storage.commit([
    insertEntry({ id: "root", parentId: null, type: "custom", customType: "note", data: { content: [{ type: "image", attachmentId: "att_1", mimeType: "image/png", byteSize: 3, sha256 }] } }),
    insertEntry({ id: "child", parentId: "root", type: "custom", customType: "note", data: { inline: [{ type: "image", data: "AAAA", mimeType: "image/png" }] } }),
    setValue(value("pi.branch.tip", "main"), "child"),
  ], BACKGROUND_CONTEXT);
  await storage.close(BACKGROUND_CONTEXT);
  const calls = { pages: 0, fetches: 0 };
  const serve: RelocationServer = {
    async snapshot(sessionId, fromSeq) { calls.pages++; return { summary: piSnapshotSummary(server, sessionId), ...readPiSnapshotPage(server, sessionId, fromSeq, 1) }; },
    async fetchAttachment(_sessionId, attachmentId) {
      calls.fetches++;
      return attachmentId === "att_1" ? { data: bytes, mimeType: "image/png", byteSize: 3, sha256 } : null;
    },
  };
  return { server, serve, calls, snapshot: piSnapshotSummary(server, "s") };
}

test("hydrate pulls the server's copy page by page with its attachments, stores it verbatim and converges on replay by content", async () => {
  const { server, serve, calls, snapshot } = await serverCopy();
  const node = new Database(":memory:");
  initializeNodeStorage(node);
  expect(await hydrateNodeSession(node, serve, { sessionId: "s", binding, task, snapshot })).toBeNull();
  expect(calls).toEqual({ pages: 3, fetches: 1 });
  expect(nodeSessionBinding(node, "s")).toEqual(binding);
  expect(nodeSessionTask(node, "s")).toEqual(task);
  expect(samePiSnapshot(piSnapshotSummary(node, "s"), snapshot)).toBe(true);
  expect(node.query("SELECT attachment_id, data FROM node_attachments").all()).toEqual([{ attachment_id: "att_1", data: Buffer.from(bytes) }]);

  // A replay (a lost acknowledgement, or a hydrate under another command) is recognized by content;
  // a different copy or binding is not (the node replaces it, see below).
  expect(holdsHydratedCopy(node, { sessionId: "s", binding, task, snapshot })).toBe(true);
  expect(holdsHydratedCopy(node, { sessionId: "s", binding, task, snapshot: { ...snapshot, harnessNextSeq: snapshot.harnessNextSeq + 1 } })).toBe(false);
  expect(holdsHydratedCopy(node, { sessionId: "s", binding: { ...binding, cwd: "/elsewhere" }, task, snapshot })).toBe(false);
  server.close(); node.close();
});

test("hydrate stores nothing when the pull does not match its snapshot, an attachment is corrupt or the server is unreachable", async () => {
  const { server, serve, snapshot } = await serverCopy();
  const node = new Database(":memory:");
  initializeNodeStorage(node);
  const stored = () => node.query("SELECT COUNT(*) n FROM sessions").get();
  const forged: RelocationServer = { ...serve, async snapshot(sessionId, fromSeq) {
    const page = await serve.snapshot(sessionId, fromSeq);
    return { ...page, rows: page.rows.map(row => row.table === "value" ? { ...row, valueJson: '"root"' } : row) };
  } };
  expect(await hydrateNodeSession(node, forged, { sessionId: "s", binding, task, snapshot }))
    .toEqual({ code: "invalid_request", message: "Hydration verification failed for session s: pulled rows do not match the snapshot", retryable: false });
  const changed = { ...snapshot, digest: "0".repeat(64) };
  expect(await hydrateNodeSession(node, serve, { sessionId: "s", binding, task, snapshot: changed }))
    .toEqual({ code: "invalid_request", message: "Server copy of session s changed during hydration", retryable: false });
  const corrupt: RelocationServer = { ...serve, fetchAttachment: async () => ({ data: bytes, mimeType: "image/png", byteSize: 3, sha256: "f".repeat(64) }) };
  expect(await hydrateNodeSession(node, corrupt, { sessionId: "s", binding, task, snapshot }))
    .toEqual({ code: "invalid_request", message: "Attachment checksum mismatch: att_1", retryable: false });
  const offline: RelocationServer = { ...serve, snapshot: async () => { throw new RpcFailure("unavailable", "Connection closed; outcome unknown", "unknown"); } };
  expect(await hydrateNodeSession(node, offline, { sessionId: "s", binding, task, snapshot }))
    .toMatchObject({ code: "unavailable", retryable: true });
  const refused: RelocationServer = { ...serve, snapshot: async () => { throw new RpcFailure(APPLICATION_ERROR, "Node session unavailable: s"); } };
  expect(await hydrateNodeSession(node, refused, { sessionId: "s", binding, task, snapshot }))
    .toEqual({ code: "invalid_request", message: "Session snapshot failed: Node session unavailable: s", retryable: false });
  expect(stored()).toEqual({ n: 0 });
  // An attachment the server no longer holds (pruned) does not block the move.
  const pruned: RelocationServer = { ...serve, fetchAttachment: async () => null };
  expect(await hydrateNodeSession(node, pruned, { sessionId: "s", binding, task, snapshot })).toBeNull();
  expect(node.query("SELECT COUNT(*) n FROM node_attachments").get()).toEqual({ n: 0 });
  server.close(); node.close();
});

const unexpected = async () => { throw new Error("unexpected server call"); };
/** A node on `db` attached to a server that serves `serve` for relocation and fails everything else. */
function nodeOn(db: Database, serve: RelocationServer, reports: Partial<NodeServer> = {}) {
  setNodeDb(db);
  const node = startNode();
  const server: NodeServer = {
    committed: unexpected, started: unexpected, settled: unexpected, storeAttachment: unexpected, event: () => {},
    executeScript: unexpected, searchScript: unexpected, createTask: unexpected,
    getCredential: unexpected, refreshCredential: unexpected, listCredentials: unexpected,
    snapshot: serve.snapshot, fetchAttachment: serve.fetchAttachment, ...reports,
  };
  return { node, server };
}
const rowsOf = (db: Database, sessionId: string) => ["session_messages", "pi_values", "pi_lists", "pi_usage", "node_attachments", "session_outbox"]
  .map(table => db.query<{ n: number }, [string]>(`SELECT COUNT(*) n FROM ${table} WHERE session_id = ?`).get(sessionId)!.n);

test("hydrate onto a node holding a copy: an identical copy is acknowledged without a pull, a stale one is replaced wholesale", async () => {
  const { server, serve, calls, snapshot } = await serverCopy();
  const db = new Database(":memory:");
  const { node, server: connection } = nodeOn(db, serve);
  try {
    node.attach(connection);
    expect(await node.hydrate({ sessionId: "s", task, snapshot }, binding)).toEqual({ ok: true, value: { kind: "hydrated" } });
    expect(calls.pages).toBe(3);
    // A replay finds the identical copy: no second pull.
    expect(await node.hydrate({ sessionId: "s", task, snapshot }, binding)).toEqual({ ok: true, value: { kind: "hydrated" } });
    expect(calls.pages).toBe(3);

    // The node's copy goes stale (a local write and an attachment and report the server never got, as
    // after a move away), while the server's copy moves on (another owner's commits).
    db.query("INSERT INTO pi_values(session_id,namespace,key,seq,value_json) VALUES('s','stale','k',99,'1')").run();
    db.query("INSERT INTO node_attachments(session_id,attachment_id,mime_type,byte_size,sha256,data) VALUES('s','att_stale','image/png',3,?,?)").run(sha256, Buffer.from(bytes));
    db.query("INSERT INTO session_outbox(session_id,kind,payload) VALUES('s','started','{\"runId\":\"stale\"}')").run();
    const storage = await openNodeStorage(server, "s", async () => {}, () => 43);
    await storage.commit([setValue(value("pi.branch.tip", "main"), "root")], BACKGROUND_CONTEXT);
    await storage.close(BACKGROUND_CONTEXT);
    const moved = piSnapshotSummary(server, "s");

    // Moving back replaces the stale copy wholesale: nothing of it survives, the new copy is the server's.
    expect(await node.hydrate({ sessionId: "s", task, snapshot: moved }, binding)).toEqual({ ok: true, value: { kind: "hydrated" } });
    expect(samePiSnapshot(piSnapshotSummary(db, "s"), moved)).toBe(true);
    expect(db.query("SELECT 1 FROM pi_values WHERE namespace = 'stale'").get()).toBeNull();
    expect(db.query("SELECT attachment_id FROM node_attachments").all()).toEqual([{ attachment_id: "att_1" }]);
    expect(db.query("SELECT 1 FROM session_outbox").get()).toBeNull();
  } finally { node.stop(); setNodeDb(); server.close(); db.close(); }
});

test("a failed replacement leaves no stale copy: commands answer not_found until a hydrate succeeds", async () => {
  const { server, serve, snapshot } = await serverCopy();
  const db = new Database(":memory:");
  const { node, server: connection } = nodeOn(db, serve);
  try {
    node.attach(connection);
    expect(await node.hydrate({ sessionId: "s", task, snapshot }, binding)).toMatchObject({ ok: true });
    const changed = { ...snapshot, digest: "0".repeat(64) };
    expect(await node.hydrate({ sessionId: "s", task, snapshot: changed }, binding)).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(nodeSessionBinding(db, "s")).toBeNull();
    expect(await node.send({ op: "session.prompt", sessionId: "s", clientId: "c", content: [] }, binding)).toMatchObject({ ok: false, error: { code: "not_found" } });
  } finally { node.stop(); setNodeDb(); server.close(); db.close(); }
});

test("not_owner: a node whose report the server refuses because the session moved drops its pending reports and copy, once, without retrying", async () => {
  const { server, serve, snapshot } = await serverCopy();
  const db = new Database(":memory:");
  let refusals = 0;
  const notOwner = async () => {
    refusals++;
    throw new RpcFailure(APPLICATION_ERROR, "Node session unavailable: s", undefined, { code: "not_owner", message: "Node session unavailable: s", retryable: false });
  };
  const { node, server: connection } = nodeOn(db, serve, { started: notOwner, committed: notOwner });
  try {
    node.attach({ ...connection, started: async () => { throw new RpcFailure("unavailable", "offline"); } });
    expect(await node.hydrate({ sessionId: "s", task, snapshot }, binding)).toMatchObject({ ok: true });
    // Reports written before the move (e.g. a commit outside a run), undelivered when it happened.
    db.query("INSERT INTO session_outbox(session_id,kind,payload) VALUES('s','started','{\"runId\":\"r\"}')").run();
    db.query("INSERT INTO session_outbox(session_id,kind,start_seq,payload) VALUES('s','committed',?,'[]')").run(snapshot.harnessNextSeq);

    // The next connection's drain is refused with not_owner: the copy and its reports are dropped.
    node.attach(connection);
    for (let i = 0; i < 200 && nodeSessionBinding(db, "s"); i++) await Bun.sleep(5);
    expect(nodeSessionBinding(db, "s")).toBeNull();
    expect(rowsOf(db, "s")).toEqual([0, 0, 0, 0, 0, 0]);
    expect(refusals).toBe(1);
    // Inactive until hydrated again: commands answer not_found (the server re-hydrates on its next
    // command) and later connections have nothing left to send.
    expect(await node.send({ op: "session.setModel", sessionId: "s", provider: "p", modelId: "m" }, binding)).toMatchObject({ ok: false, error: { code: "not_found" } });
    node.attach(connection);
    await Bun.sleep(20);
    expect(refusals).toBe(1);
    // A later hydrate brings it back.
    expect(await node.hydrate({ sessionId: "s", task, snapshot }, binding)).toMatchObject({ ok: true });
    expect(samePiSnapshot(piSnapshotSummary(db, "s"), snapshot)).toBe(true);
  } finally { node.stop(); setNodeDb(); server.close(); db.close(); }
});

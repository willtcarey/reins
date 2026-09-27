import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { BACKGROUND_CONTEXT, insertEntry, setValue, value } from "@earendil-works/pi-agent-core";
import { toolImageReferences } from "./runtime/tool-images.js";
import { join } from "node:path";
import { bindNodeSession, completeNodeReport, deliverNodeOutbox, initializeNodeStorage, nodeSessionBinding, nodeSessionTask, nodeStoragePath, openNodeStorage, provisionNodeSession, recordNodeReport, releaseUnreadReports, type NodeOutboxItem } from "./storage.js";

const binding = { sourceId: 1, cwd: "/tmp/node", createdAt: "2026-01-01T00:00:00.000Z", parentSessionId: null };

test("node storage uses the user's node directory, independent of the server data directory", () => {
  expect(nodeStoragePath()).toBe(join(homedir(), ".reins", "node", "storage.db"));
  expect(nodeStoragePath("/tmp/home")).toBe("/tmp/home/.reins/node/storage.db");
});

test("provision stores an immutable binding: an equal repeat is a no-op, a different one rejects", () => {
  const db = new Database(":memory:");
  initializeNodeStorage(db);
  const task = { title: "T", description: null, branchName: "task/t" };
  provisionNodeSession(db, "s", binding, task);
  provisionNodeSession(db, "s", binding, { ...task, title: "Later" });
  expect(nodeSessionBinding(db, "s")).toEqual(binding);
  expect(nodeSessionTask(db, "s")).toEqual(task);
  expect(() => provisionNodeSession(db, "s", { ...binding, cwd: "/elsewhere" }, task)).toThrow("binding mismatch");
  db.close();
});

const commit = (db: Database, startSeq: number, payload: string) =>
  db.query("INSERT INTO session_outbox(session_id,kind,start_seq,payload) VALUES ('s','committed',?,?)").run(startSeq, payload);
const payloadOf = (item: NodeOutboxItem) => "payload" in item ? item.payload : item.attachment.attachmentId;
const outbox = (db: Database) => db.query<{ payload: string }, []>("SELECT payload FROM session_outbox ORDER BY id").all().map(row => row.payload);

test("pending reports survive rejected or not-yet-acknowledged async delivery and drain in order", async () => {
  const db = new Database(":memory:");
  initializeNodeStorage(db);
  bindNodeSession(db, "s", binding);
  commit(db, 1, "one"); commit(db, 2, "two");
  let acknowledge!: () => void;
  const received: string[] = [];
  const inFlight = deliverNodeOutbox(db, "s", async (_id, item) => {
    const payload = payloadOf(item);
    received.push(payload);
    if (payload === "one") await new Promise<void>(resolve => { acknowledge = resolve; });
  });
  const concurrent = deliverNodeOutbox(db, "s", async (_id, item) => { received.push(`duplicate:${payloadOf(item)}`); });
  await Promise.resolve();
  await Promise.resolve();
  expect(received).toEqual(["one"]);
  expect(outbox(db)).toEqual(["one", "two"]);
  acknowledge();
  await Promise.all([inFlight, concurrent]);
  expect(received).toEqual(["one", "two"]);
  expect(outbox(db)).toEqual([]);
  commit(db, 3, "three");
  await expect(deliverNodeOutbox(db, "s", async () => { throw new Error("server unavailable"); })).rejects.toThrow("server unavailable");
  expect(outbox(db)).toEqual(["three"]);
  await deliverNodeOutbox(db, "s", async () => {});
  expect(outbox(db)).toEqual([]);
  db.close();
});

test("lifecycle reports drain after the commits recorded before them, and a held settlement holds back later reports", async () => {
  const db = new Database(":memory:");
  initializeNodeStorage(db);
  bindNodeSession(db, "s", binding);
  const received: NodeOutboxItem[] = [];
  const deliver = async (_id: string, item: NodeOutboxItem) => { received.push(item); };
  recordNodeReport(db, "s", "started", '{"runId":"r1"}');
  commit(db, 1, "run-1 writes");
  const held = recordNodeReport(db, "s", "settled", '{"runId":"r1","reply":null}', false);
  recordNodeReport(db, "s", "started", '{"runId":"r2"}');
  commit(db, 2, "run-2 writes");
  await deliverNodeOutbox(db, "s", deliver);
  expect(received).toEqual([
    { kind: "started", payload: '{"runId":"r1"}' },
    { kind: "committed", startSeq: 1, payload: "run-1 writes" },
  ]);
  completeNodeReport(db, held, '{"runId":"r1","reply":{"text":"done"}}');
  await deliverNodeOutbox(db, "s", deliver);
  expect(received.slice(2)).toEqual([
    { kind: "settled", payload: '{"runId":"r1","reply":{"text":"done"}}' },
    { kind: "started", payload: '{"runId":"r2"}' },
    { kind: "committed", startSeq: 2, payload: "run-2 writes" },
  ]);
  expect(outbox(db)).toEqual([]);
  db.close();
});

test("a node restart releases a settlement whose reply read never finished as reply-unavailable", async () => {
  const db = new Database(":memory:");
  initializeNodeStorage(db);
  bindNodeSession(db, "s", binding);
  recordNodeReport(db, "s", "settled", '{"runId":"r1","reply":null}', false);
  releaseUnreadReports(db, "restarted");
  const received: NodeOutboxItem[] = [];
  await deliverNodeOutbox(db, "s", async (_id, item) => { received.push(item); });
  expect(received.map(item => JSON.parse(payloadOf(item)))).toEqual([{ runId: "r1", reply: null, replyError: "restarted" }]);
  db.close();
});

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const inlineResult = (id: string) => ({
  id, parentId: null, type: "message" as const,
  message: { role: "toolResult" as const, toolCallId: id, toolName: "read", isError: false, timestamp: 1,
    content: [{ type: "text" as const, text: "Read image" }, { type: "image" as const, data: png.toString("base64"), mimeType: "image/png" }] },
});

test("the node storage adapter references inline images Pi commits without the hook, ahead of the commit, in one transaction", async () => {
  const db = new Database(":memory:");
  initializeNodeStorage(db);
  bindNodeSession(db, "s", binding);
  const received: NodeOutboxItem[] = [];
  let online = false;
  const storage = await openNodeStorage(db, "s", async (_id, item) => { if (!online) throw new Error("offline"); received.push(item); });
  // A tool result staged and committed with its bytes (e.g. a checkpoint republished on recovery).
  await storage.commit([
    setValue(value("pi.pending.entry", "result"), { type: "message", payload: inlineResult("staged").message }),
    insertEntry(inlineResult("result")),
  ], BACKGROUND_CONTEXT);
  const rows = db.query<{ id: number; kind: string; payload: string }, []>("SELECT id, kind, payload FROM session_outbox ORDER BY id").all();
  // The staged and committed copies hold the same bytes: one cached row, one upload, one ID.
  expect(rows.map(row => row.kind)).toEqual(["attachment", "committed"]);
  const id: string = JSON.parse(rows[0]!.payload).attachmentId;
  // Neither node storage nor the replicated batch holds the bytes; both hold the reference.
  const stored = JSON.stringify([db.query("SELECT message_json FROM session_messages").all(), db.query("SELECT value_json FROM pi_values").all(), rows[1]!.payload]);
  expect(stored).not.toContain(png.toString("base64"));
  expect(stored).toContain(id);
  const entry = (await storage.getEntries(["result"], BACKGROUND_CONTEXT)).get("result");
  expect<unknown>(entry?.type === "message" && entry.message.role === "toolResult" && entry.message.content[1]).toEqual({
    type: "image", attachmentId: id, mimeType: "image/png", byteSize: png.length, sha256: createHash("sha256").update(png).digest("hex"),
  });

  // A commit that fails (here, a duplicate entry ID) rolls its conversion back with it.
  await expect(storage.commit([insertEntry(inlineResult("result"))], BACKGROUND_CONTEXT)).rejects.toThrow("Duplicate");
  expect(db.query("SELECT COUNT(*) AS n FROM node_attachments").get()).toEqual({ n: 1 });
  expect(db.query("SELECT COUNT(*) AS n FROM session_outbox").get()).toEqual({ n: 2 });

  // Repeated checkpoints of the same output reuse the reference: no new cache row or upload.
  const checkpoint = { content: inlineResult("checkpoint").message.content, details: null };
  await storage.commit([setValue(value("pi.pending.tool_output", "call"), checkpoint)], BACKGROUND_CONTEXT);
  await storage.commit([setValue(value("pi.pending.tool_output", "call"), checkpoint)], BACKGROUND_CONTEXT);
  expect(db.query("SELECT kind FROM session_outbox ORDER BY id").all()).toEqual(["attachment", "committed", "committed", "committed"].map(kind => ({ kind })));
  expect(db.query("SELECT COUNT(*) AS n FROM node_attachments").get()).toEqual({ n: 1 });

  // Delivery sends the upload with its cached bytes before every commit that references it.
  online = true;
  await deliverNodeOutbox(db, "s", async (_id, item) => { received.push(item); });
  expect(received.map(item => item.kind)).toEqual(["attachment", "committed", "committed", "committed"]);
  expect(received[0]).toEqual({ kind: "attachment", attachment: {
    attachmentId: id, mimeType: "image/png", byteSize: png.length, sha256: createHash("sha256").update(png).digest("hex"), data: new Uint8Array(png),
  } });
  expect(received.slice(1).every(item => item.kind === "committed" && item.payload.includes(id))).toBe(true);
  expect(outbox(db)).toEqual([]);
  await storage.close(BACKGROUND_CONTEXT);
  db.close();
});

test("an image the after_tool hook already referenced is reused when the safety net meets its bytes again", async () => {
  const db = new Database(":memory:");
  initializeNodeStorage(db);
  bindNodeSession(db, "s", binding);
  const storage = await openNodeStorage(db, "s", () => { throw new Error("offline"); });
  const [reference] = toolImageReferences(db, "s")([{ type: "image", data: png.toString("base64"), mimeType: "image/png" }])!;
  // e.g. the checkpointed inline result republished on recovery after the hook had run.
  await storage.commit([insertEntry(inlineResult("result"))], BACKGROUND_CONTEXT);
  const rows = db.query<{ kind: string; payload: string }, []>("SELECT kind, payload FROM session_outbox ORDER BY id").all();
  expect(rows.map(row => row.kind)).toEqual(["attachment", "committed"]);
  expect(rows[1]!.payload).toContain(JSON.stringify(reference));
  expect(rows[1]!.payload).not.toContain(png.toString("base64"));
  expect(db.query("SELECT COUNT(*) AS n FROM node_attachments").get()).toEqual({ n: 1 });
  await storage.close(BACKGROUND_CONTEXT);
  db.close();
});

test("an upload the server rejects stays pending and holds back that session's later reports", async () => {
  const db = new Database(":memory:");
  initializeNodeStorage(db);
  bindNodeSession(db, "s", binding);
  const [reference] = toolImageReferences(db, "s")([{ type: "image", data: png.toString("base64"), mimeType: "image/png" }])!;
  commit(db, 1, JSON.stringify([reference]));
  const attempts: string[] = [];
  const reject = async (_id: string, item: NodeOutboxItem) => { attempts.push(item.kind); if (item.kind === "attachment") throw new Error("divergent"); };
  await expect(deliverNodeOutbox(db, "s", reject)).rejects.toThrow("divergent");
  await expect(deliverNodeOutbox(db, "s", reject)).rejects.toThrow("divergent");
  expect(attempts).toEqual(["attachment", "attachment"]);
  expect(db.query("SELECT kind FROM session_outbox ORDER BY id").all()).toEqual([{ kind: "attachment" }, { kind: "committed" }]);
  db.close();
});

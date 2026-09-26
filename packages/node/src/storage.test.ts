import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { bindNodeSession, completeNodeReport, deliverNodeOutbox, initializeNodeStorage, nodeAdmissionReceipt, nodeStoragePath, recordNodeAdmission, recordNodeReport, releaseUnreadReports, type NodeOutboxItem } from "./storage.js";

const binding = { sourceId: 1, cwd: "/tmp/node", createdAt: "2026-01-01T00:00:00.000Z", parentSessionId: null };

test("node storage uses the user's node directory, independent of the server data directory", () => {
  expect(nodeStoragePath()).toBe(join(homedir(), ".reins", "node", "storage.db"));
  expect(nodeStoragePath("/tmp/home")).toBe("/tmp/home/.reins/node/storage.db");
});

test("provision receipt and immutable binding are committed together", () => {
  const db = new Database(":memory:");
  initializeNodeStorage(db);
  recordNodeAdmission(db, "command-1", "s", "provision", "payload-1", () => bindNodeSession(db, "s", binding));
  expect(nodeAdmissionReceipt(db, "command-1")).toEqual({ sessionId: "s", operation: "provision", payload: "payload-1" });
  expect(() => recordNodeAdmission(db, "command-2", "other", "provision", "payload-2", () => {
    bindNodeSession(db, "other", binding);
    throw new Error("admission failed");
  })).toThrow("admission failed");
  expect(db.query("SELECT id FROM sessions WHERE id = 'other'").get()).toBeNull();
  expect(nodeAdmissionReceipt(db, "command-2")).toBeNull();
  expect(() => recordNodeAdmission(db, "command-1", "s", "provision", "different", () => {})).toThrow("receipt mismatch");
  db.close();
});

const commit = (db: Database, startSeq: number, payload: string) =>
  db.query("INSERT INTO session_outbox(session_id,kind,start_seq,payload) VALUES ('s','committed',?,?)").run(startSeq, payload);
const outbox = (db: Database) => db.query<{ payload: string }, []>("SELECT payload FROM session_outbox ORDER BY id").all().map(row => row.payload);

test("pending reports survive rejected or not-yet-acknowledged async delivery and drain in order", async () => {
  const db = new Database(":memory:");
  initializeNodeStorage(db);
  bindNodeSession(db, "s", binding);
  commit(db, 1, "one"); commit(db, 2, "two");
  let acknowledge!: () => void;
  const received: string[] = [];
  const inFlight = deliverNodeOutbox(db, "s", async (_id, { payload }) => {
    received.push(payload);
    if (payload === "one") await new Promise<void>(resolve => { acknowledge = resolve; });
  });
  const concurrent = deliverNodeOutbox(db, "s", async (_id, { payload }) => { received.push(`duplicate:${payload}`); });
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
  expect(received.map(item => JSON.parse(item.payload))).toEqual([{ runId: "r1", reply: null, replyError: "restarted" }]);
  db.close();
});

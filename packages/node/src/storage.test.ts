import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { bindNodeSession, deliverNodeCommits, initializeNodeStorage, nodeAdmissionReceipt, recordNodeAdmission } from "./storage.js";

const binding = { sourceId: 1, cwd: "/tmp/node", createdAt: "2026-01-01T00:00:00.000Z", parentSessionId: null };

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

test("pending writes survive rejected or not-yet-acknowledged async delivery and drain in order", async () => {
  const db = new Database(":memory:");
  initializeNodeStorage(db);
  bindNodeSession(db, "s", binding);
  db.query("INSERT INTO pending_commits(session_id,start_seq,writes_json) VALUES ('s',1,'one'),('s',2,'two')").run();
  let acknowledge!: () => void;
  const received: string[] = [];
  const inFlight = deliverNodeCommits(db, "s", async (_id, _seq, json) => {
    received.push(json);
    if (json === "one") await new Promise<void>(resolve => { acknowledge = resolve; });
  });
  const concurrent = deliverNodeCommits(db, "s", async (_id, _seq, json) => { received.push(`duplicate:${json}`); });
  await Promise.resolve();
  await Promise.resolve();
  expect(received).toEqual(["one"]);
  expect(db.query("SELECT start_seq FROM pending_commits ORDER BY start_seq").all()).toEqual([{ start_seq: 1 }, { start_seq: 2 }]);
  acknowledge();
  await Promise.all([inFlight, concurrent]);
  expect(received).toEqual(["one", "two"]);
  expect(db.query("SELECT * FROM pending_commits").all()).toEqual([]);
  db.query("INSERT INTO pending_commits(session_id,start_seq,writes_json) VALUES ('s',3,'three')").run();
  await expect(deliverNodeCommits(db, "s", async () => { throw new Error("server unavailable"); })).rejects.toThrow("server unavailable");
  expect(db.query("SELECT writes_json FROM pending_commits").all()).toEqual([{ writes_json: "three" }]);
  await deliverNodeCommits(db, "s", async () => {});
  expect(db.query("SELECT * FROM pending_commits").all()).toEqual([]);
  db.close();
});

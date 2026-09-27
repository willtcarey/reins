import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendList, BACKGROUND_CONTEXT, list, setValue, value } from "@earendil-works/pi-agent-core";
import { insertEntry, insertUsage } from "@earendil-works/pi-agent-core/harness/session";
import { piSnapshotSummary, readPiSnapshotPage, samePiSnapshot, summarizePiSnapshot, writePiSnapshot, type PiSnapshotRow } from "./pi-storage.js";
import { bindNodeSession, initializeNodeStorage, openNodeStorage } from "./storage.js";

test("Pi commits locally before async delivery and retries pending writes after server acknowledgement failure", async () => {
  const db = new Database(":memory:");
  initializeNodeStorage(db);
  bindNodeSession(db, "s", { sourceId: 1, cwd: "/tmp/node", createdAt: "2026-01-01", parentSessionId: null });
  let ack!: () => void;
  const storage = await openNodeStorage(db, "s", async () => new Promise<void>(resolve => { ack = resolve; }));
  const committed = storage.commit([setValue(value("test", "key"), "durable")], BACKGROUND_CONTEXT);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(db.query("SELECT start_seq FROM session_outbox").all()).toEqual([{ start_seq: 1 }]);
  expect(db.query("SELECT value_json FROM pi_values").get()).toEqual({ value_json: '"durable"' });
  ack();
  await committed;
  expect(db.query("SELECT * FROM session_outbox").all()).toEqual([]);
  await storage.close(BACKGROUND_CONTEXT);

  const offline = await openNodeStorage(db, "s", async () => { throw new Error("offline"); });
  await offline.commit([setValue(value("test", "key"), "offline")], BACKGROUND_CONTEXT);
  expect(db.query("SELECT start_seq FROM session_outbox").all()).toEqual([{ start_seq: 2 }]);
  await offline.close(BACKGROUND_CONTEXT);
  const restored = await openNodeStorage(db, "s", async () => {});
  expect(db.query("SELECT * FROM session_outbox").all()).toEqual([]);
  expect((await restored.getValue(value("test", "key"), BACKGROUND_CONTEXT))?.value).toBe("offline");
  await restored.close(BACKGROUND_CONTEXT);
  db.close();
});

test("a session snapshot copies every row verbatim in pages and the copy continues from the copied sequence", async () => {
  const source = new Database(":memory:");
  initializeNodeStorage(source);
  const binding = { sourceId: 1, cwd: "/tmp/node", createdAt: "2026-01-01", parentSessionId: null };
  bindNodeSession(source, "s", binding);
  const storage = await openNodeStorage(source, "s", async () => {}, () => 42);
  const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  await storage.commit([
    insertEntry({ id: "root", parentId: null, type: "custom", customType: "note", data: { n: 1 } }),
    insertEntry({ id: "child", parentId: "root", type: "custom", customType: "note", data: { n: 2 } }),
    setValue(value("pi.branch.tip", "main"), "child"),
    appendList(list("test", "items"), { exact: true }),
    insertUsage({ id: "usage-1", entryId: "child", adjustment: false, usage }),
  ], BACKGROUND_CONTEXT);
  // Overwritten values keep only their last write's seq.
  await storage.commit([setValue(value("pi.branch.tip", "main"), "root")], BACKGROUND_CONTEXT);
  await storage.close(BACKGROUND_CONTEXT);
  const summary = piSnapshotSummary(source, "s");
  expect(summary).toMatchObject({ harnessNextSeq: 7, rowCounts: { entries: 2, values: 1, lists: 1, usage: 1 } });

  // Pages of two rows never split a seq and end with nextSeq null.
  const rows: PiSnapshotRow[] = [];
  for (let from: number | null = 0; from !== null;) {
    const page = readPiSnapshotPage(source, "s", from, 2);
    expect(page.rows.length).toBeLessThanOrEqual(2);
    rows.push(...page.rows);
    from = page.nextSeq;
  }
  expect(rows.map(row => [row.table, row.seq])).toEqual([["entry", 1], ["entry", 2], ["list", 4], ["usage", 5], ["value", 6]]);
  expect(samePiSnapshot(summarizePiSnapshot(summary.harnessNextSeq, rows), summary)).toBe(true);
  // Any change to any row changes the digest.
  const altered = rows.map(row => row.table === "list" ? { ...row, valueJson: '{"exact":false}' } : row);
  expect(summarizePiSnapshot(summary.harnessNextSeq, altered).digest).not.toBe(summary.digest);

  const target = new Database(":memory:");
  initializeNodeStorage(target);
  bindNodeSession(target, "s", binding);
  target.transaction(() => writePiSnapshot(target, "s", summary.harnessNextSeq, rows.toReversed()))();
  expect(samePiSnapshot(piSnapshotSummary(target, "s"), summary)).toBe(true);
  const delivered: number[] = [];
  const copy = await openNodeStorage(target, "s", async (_session, item) => { if (item.kind === "committed") delivered.push(item.startSeq); });
  expect((await copy.scanBranch({ start: "child", order: "oldestFirst" }, BACKGROUND_CONTEXT)).map(entry => entry.id)).toEqual(["root", "child"]);
  // New commits continue from the copied sequence.
  await copy.commit([setValue(value("test", "after"), 1)], BACKGROUND_CONTEXT);
  expect(delivered).toEqual([7]);
  await copy.close(BACKGROUND_CONTEXT);

  source.close(); target.close();
});

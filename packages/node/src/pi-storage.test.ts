import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendList, BACKGROUND_CONTEXT, list, setValue, value } from "@earendil-works/pi-agent-core";
import { insertEntry, insertUsage } from "@earendil-works/pi-agent-core/harness/session";
import { createStorageConformance } from "@earendil-works/pi-agent-core/harness/session/testing";
import { PiStorageAdapter, piSnapshotSummary, readPiSnapshotPage, samePiSnapshot, summarizePiSnapshot, writePiSnapshot, type PiSnapshotRow } from "./pi-storage.js";
import { bindNodeSession, openNodeStorage, createOutboxDrain } from "./storage.js";
import { runNodeMigrations } from "./migrations.js";

test("Pi commits locally before async delivery and retries pending writes after server acknowledgement failure", async () => {
  const db = new Database(":memory:");
  runNodeMigrations(db);
  bindNodeSession(db, "s", { sourceId: 1, cwd: "/tmp/node", createdAt: "2026-01-01", parentSessionId: null });
  let ack!: () => void;
  const storage = await openNodeStorage(db, "s", createOutboxDrain(db, async () => new Promise<void>(resolve => { ack = resolve; })));
  const committed = storage.commit([setValue(value("test", "key"), "durable")], BACKGROUND_CONTEXT);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(db.query("SELECT start_seq FROM session_outbox").all()).toEqual([{ start_seq: 1 }]);
  expect(db.query("SELECT value_json FROM pi_values").get()).toEqual({ value_json: '"durable"' });
  ack();
  await committed;
  expect(db.query("SELECT * FROM session_outbox").all()).toEqual([]);
  await storage.close(BACKGROUND_CONTEXT);

  const offline = await openNodeStorage(db, "s", createOutboxDrain(db, async () => { throw new Error("offline"); }));
  await offline.commit([setValue(value("test", "key"), "offline")], BACKGROUND_CONTEXT);
  expect(db.query("SELECT start_seq FROM session_outbox").all()).toEqual([{ start_seq: 2 }]);
  await offline.close(BACKGROUND_CONTEXT);
  const restored = await openNodeStorage(db, "s", createOutboxDrain(db, async () => {}));
  expect(db.query("SELECT * FROM session_outbox").all()).toEqual([]);
  expect((await restored.getValue(value("test", "key"), BACKGROUND_CONTEXT))?.value).toBe("offline");
  await restored.close(BACKGROUND_CONTEXT);
  db.close();
});

test("a session snapshot copies every row verbatim in pages and the copy continues from the copied sequence", async () => {
  const source = new Database(":memory:");
  runNodeMigrations(source);
  const binding = { sourceId: 1, cwd: "/tmp/node", createdAt: "2026-01-01", parentSessionId: null };
  bindNodeSession(source, "s", binding);
  const storage = await openNodeStorage(source, "s", createOutboxDrain(source, async () => {}), () => 42);
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
  runNodeMigrations(target);
  bindNodeSession(target, "s", binding);
  target.transaction(() => writePiSnapshot(target, "s", summary.harnessNextSeq, rows.toReversed()))();
  expect(samePiSnapshot(piSnapshotSummary(target, "s"), summary)).toBe(true);
  const delivered: number[] = [];
  const copy = await openNodeStorage(target, "s", createOutboxDrain(target, async (_session, item) => { if (item.kind === "committed") delivered.push(item.startSeq); }));
  expect((await copy.scanBranch({ start: "child", order: "oldestFirst" }, BACKGROUND_CONTEXT)).map(entry => entry.id)).toEqual(["root", "child"]);
  // New commits continue from the copied sequence.
  await copy.commit([setValue(value("test", "after"), 1)], BACKGROUND_CONTEXT);
  expect(delivered).toEqual([7]);
  await copy.close(BACKGROUND_CONTEXT);

  source.close(); target.close();
});

/** A node database with `sessionIds` bound. */
function nodeDb(...sessionIds: string[]): Database {
  const db = new Database(":memory:");
  runNodeMigrations(db);
  for (const id of sessionIds) bindNodeSession(db, id, { sourceId: 1, cwd: `/tmp/${id}`, createdAt: "2026-01-01", parentSessionId: null });
  return db;
}

for (const testCase of createStorageConformance(async () => {
  const db = nodeDb("session");
  const storage = new PiStorageAdapter(db, "session", () => 1_700_000_000_000);
  return {
    storage,
    async [Symbol.asyncDispose]() {
      await storage.close(BACKGROUND_CONTEXT);
      db.close();
    },
  };
})) test(`Storage: ${testCase.group}: ${testCase.name}`, testCase.run);

describe("PiStorageAdapter", () => {
  test("rejects an unknown session", () => {
    const db = nodeDb();
    try {
      expect(() => new PiStorageAdapter(db, "missing")).toThrow("Unknown session: missing");
    } finally {
      db.close();
    }
  });

  test("uses global sequences, integer rows, exact harness ids, and real parent links", async () => {
    const db = nodeDb("session");
    try {
      const storage = new PiStorageAdapter(db, "session", () => 42);
      await storage.commit([
        insertEntry({ id: "root", parentId: null, type: "message", message: { role: "user", content: "new", timestamp: 1 } }),
        insertEntry({ id: "child", parentId: "root", type: "custom", customType: "note", data: { exact: true } }),
      ], BACKGROUND_CONTEXT);

      const rows = db.query<{ id: number; seq: number; parent_id: number | null; harness_id: string }, []>(
        "SELECT id, seq, parent_id, harness_id FROM session_messages ORDER BY seq",
      ).all();
      expect(rows).toEqual([
        { id: rows[0]!.id, seq: 1, parent_id: null, harness_id: "root" },
        { id: rows[1]!.id, seq: 2, parent_id: rows[0]!.id, harness_id: "child" },
      ]);
      expect(await storage.getEntries(["child"], BACKGROUND_CONTEXT)).toEqual(new Map([["child", {
        id: "child",
        parentId: "root",
        seq: 2,
        timestamp: 42,
        type: "custom",
        customType: "note",
        data: { exact: true },
      }]]));
      await storage.close(BACKGROUND_CONTEXT);
    } finally {
      db.close();
    }
  });

  test("keeps reads and parent resolution inside the owning session", async () => {
    const db = nodeDb("one", "two");
    try {
      const one = new PiStorageAdapter(db, "one", () => 42);
      const two = new PiStorageAdapter(db, "two", () => 42);
      await one.commit([insertEntry({ id: "one-root", parentId: null, type: "custom", customType: "note" })], BACKGROUND_CONTEXT);
      await two.commit([insertEntry({ id: "two-root", parentId: null, type: "custom", customType: "note" })], BACKGROUND_CONTEXT);

      expect(await one.getEntries(["one-root", "two-root"], BACKGROUND_CONTEXT)).toEqual(new Map([["one-root", {
        id: "one-root", parentId: null, seq: 1, timestamp: 42, type: "custom", customType: "note",
      }]]));
      await expect(one.commit([
        insertEntry({ id: "invalid-child", parentId: "two-root", type: "custom", customType: "note" }),
      ], BACKGROUND_CONTEXT)).rejects.toThrow("Missing parent entry: two-root");
      await Promise.all([one.close(BACKGROUND_CONTEXT), two.close(BACKGROUND_CONTEXT)]);
    } finally {
      db.close();
    }
  });

  test("scopes recursive ancestry to the session and stops malformed cycles", async () => {
    const db = nodeDb("one", "two");
    try {
      const one = new PiStorageAdapter(db, "one", () => 42);
      const two = new PiStorageAdapter(db, "two", () => 42);
      await one.commit([
        insertEntry({ id: "one-root", parentId: null, type: "custom", customType: "note" }),
        insertEntry({ id: "one-child", parentId: "one-root", type: "custom", customType: "note" }),
      ], BACKGROUND_CONTEXT);
      await two.commit([insertEntry({ id: "two-root", parentId: null, type: "custom", customType: "note" })], BACKGROUND_CONTEXT);

      db.exec("PRAGMA foreign_keys = OFF");
      const oneRoot = messageRowId(db, "one-root");
      const oneChild = messageRowId(db, "one-child");
      const twoRoot = messageRowId(db, "two-root");
      db.query("UPDATE session_messages SET parent_id = ? WHERE id = ?").run(twoRoot, oneRoot);
      expect((await one.scanBranch({ start: "one-root" }, BACKGROUND_CONTEXT)).map((entry) => entry.id)).toEqual(["one-root"]);
      db.query("UPDATE session_messages SET parent_id = ? WHERE id = ?").run(oneChild, oneRoot);
      expect((await one.scanBranch({ start: "one-child", order: "newestFirst" }, BACKGROUND_CONTEXT)).map((entry) => entry.id)).toEqual(["one-child", "one-root"]);
      db.exec("PRAGMA foreign_keys = ON");
      await Promise.all([one.close(BACKGROUND_CONTEXT), two.close(BACKGROUND_CONTEXT)]);
    } finally {
      db.close();
    }
  });
});

function messageRowId(db: Database, harnessId: string): number {
  const row = db.query<{ id: number }, [string]>(
    "SELECT id FROM session_messages WHERE harness_id = ?",
  ).get(harnessId);
  if (!row) throw new Error(`Missing test message: ${harnessId}`);
  return row.id;
}

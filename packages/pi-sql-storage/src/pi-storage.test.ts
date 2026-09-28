import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendList, BACKGROUND_CONTEXT, list, setValue, value } from "@earendil-works/pi-agent-core";
import { insertEntry, insertUsage } from "@earendil-works/pi-agent-core/harness/session";
import { createStorageConformance } from "@earendil-works/pi-agent-core/harness/session/testing";
import { PiStorageAdapter, piSnapshotSummary, readPiSnapshotPage, samePiSnapshot, summarizePiSnapshot, writePiSnapshot, type PiSnapshotRow } from "./pi-storage.js";

/** The shared Pi table layout as the node and server migrations create it (each owns its own ledger;
 * extra columns they add are irrelevant here). */
const PI_TABLES = `CREATE TABLE sessions (id TEXT PRIMARY KEY, harness_next_seq INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE session_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL, parent_id INTEGER REFERENCES session_messages(id) ON DELETE SET NULL,
    harness_id TEXT NOT NULL, role TEXT NOT NULL, message_json TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(session_id, seq), UNIQUE(session_id, harness_id));
  CREATE TABLE pi_values (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    namespace TEXT NOT NULL, key TEXT NOT NULL, seq INTEGER NOT NULL, value_json TEXT NOT NULL,
    PRIMARY KEY(session_id, namespace, key));
  CREATE TABLE pi_lists (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    namespace TEXT NOT NULL, key TEXT NOT NULL, seq INTEGER NOT NULL, value_json TEXT NOT NULL,
    PRIMARY KEY(session_id, namespace, key, seq));
  CREATE TABLE pi_usage (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    id TEXT NOT NULL, seq INTEGER NOT NULL, entry_id TEXT, adjustment INTEGER NOT NULL,
    usage_json TEXT NOT NULL, details_json TEXT, PRIMARY KEY(session_id, id), UNIQUE(session_id, seq))`;

test("a session snapshot copies every row verbatim in pages and the copy continues from the copied sequence", async () => {
  const source = piDb("s");
  const storage = new PiStorageAdapter(source, "s", () => 42);
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

  const target = piDb("s");
  target.transaction(() => writePiSnapshot(target, "s", summary.harnessNextSeq, rows.toReversed()))();
  expect(samePiSnapshot(piSnapshotSummary(target, "s"), summary)).toBe(true);
  const recorded: number[] = [];
  const copy = new PiStorageAdapter(target, "s", () => 42, { record: startSeq => recorded.push(startSeq), deliver: async () => {} });
  expect((await copy.scanBranch({ start: "child", order: "oldestFirst" }, BACKGROUND_CONTEXT)).map(entry => entry.id)).toEqual(["root", "child"]);
  // New commits continue from the copied sequence.
  await copy.commit([setValue(value("test", "after"), 1)], BACKGROUND_CONTEXT);
  expect(recorded).toEqual([7]);
  await copy.close(BACKGROUND_CONTEXT);

  source.close(); target.close();
});

/** A database with the Pi tables and `sessionIds` created. */
function piDb(...sessionIds: string[]): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(PI_TABLES);
  for (const id of sessionIds) db.query("INSERT INTO sessions (id) VALUES (?)").run(id);
  return db;
}

for (const testCase of createStorageConformance(async () => {
  const db = piDb("session");
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
    const db = piDb();
    try {
      expect(() => new PiStorageAdapter(db, "missing")).toThrow("Unknown session: missing");
    } finally {
      db.close();
    }
  });

  test("uses global sequences, integer rows, exact harness ids, and real parent links", async () => {
    const db = piDb("session");
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
    const db = piDb("one", "two");
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
    const db = piDb("one", "two");
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

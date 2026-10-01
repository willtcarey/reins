import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { insertEntry } from "@earendil-works/pi-agent-core/harness/session";
import { createStorageConformance } from "@earendil-works/pi-agent-core/harness/session/testing";
import { PiStorageAdapter } from "../pi-storage.js";
import { createProject } from "../project-store.js";
import { setupTestDb, teardownTestDb } from "./helpers/test-db.js";
import { createSession } from "./session-fixture.js";

/** The server's database with a project and a session for each of `sessionIds`. */
function piDb(...sessionIds: string[]): Database {
  const db = setupTestDb();
  const project = createProject("Pi storage", "/tmp/pi-storage");
  for (const id of sessionIds) createSession(id, project.id, { agentRuntimeType: "pi" });
  return db;
}

for (const testCase of createStorageConformance(async () => {
  const db = piDb("session");
  const storage = new PiStorageAdapter(db, "session", () => 1_700_000_000_000);
  return {
    storage,
    async [Symbol.asyncDispose]() {
      await storage.close(BACKGROUND_CONTEXT);
      teardownTestDb();
    },
  };
})) test(`Storage: ${testCase.group}: ${testCase.name}`, testCase.run);

describe("PiStorageAdapter", () => {
  test("rejects an unknown session", () => {
    const db = piDb();
    try {
      expect(() => new PiStorageAdapter(db, "missing")).toThrow("Unknown session: missing");
    } finally {
      teardownTestDb();
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
      teardownTestDb();
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
      teardownTestDb();
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
      teardownTestDb();
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

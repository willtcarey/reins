import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertCanonicalHistoryBeforeStartup } from "../startup-history-check.js";
import { runMigrations } from "../migrations.js";

describe("startup history check", () => {
  test("allows a fresh data directory without creating a database", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reins-history-check-"));
    try {
      expect(assertCanonicalHistoryBeforeStartup(dir)).toBe("fresh");
      expect(await Bun.file(join(dir, "reins.db")).exists()).toBe(false);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("accepts canonical AgentHarness history", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reins-history-check-"));
    try {
      const db = new Database(join(dir, "reins.db"));
      db.exec("PRAGMA foreign_keys=ON");
      runMigrations(db);
      db.close();
      expect(assertCanonicalHistoryBeforeStartup(dir)).toBe("canonical");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("rejects old history without modifying the database", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reins-history-check-"));
    try {
      const path = join(dir, "reins.db");
      const db = new Database(path);
      db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY); CREATE TABLE session_messages (id INTEGER PRIMARY KEY, message_json TEXT)");
      db.close();
      const before = await readFile(path);
      expect(() => assertCanonicalHistoryBeforeStartup(dir)).toThrow("Unsupported Reins history format");
      expect(await readFile(path)).toEqual(before);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { resetDb } from "../db.js";
import { runMigrations } from "../migrations.js";

const PRE_RUNTIME_MIGRATIONS = [
  "001_create_projects",
  "002_add_base_branch",
  "003_create_sessions",
  "004_create_session_messages",
  "005_session_indexes",
  "006_create_tasks",
  "007_add_session_task_id",
  "008_add_task_status",
  "009_timestamps_utc_suffix",
  "010_rename_task_status_merged_to_closed",
  "011_add_task_base_commit",
  "012_add_parent_session_id",
  "013_remove_duplicate_compaction_markers",
  "014_create_settings",
  "015_create_auth_credentials",
] as const;

afterEach(() => {
  resetDb();
});

describe("session runtime metadata migration", () => {
  test("adds agent_runtime_type with default pi and backfills existing rows", () => {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec(`
      CREATE TABLE migrations (
        name TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        project_id INTEGER NOT NULL,
        name TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        model_provider TEXT,
        model_id TEXT,
        thinking_level TEXT DEFAULT 'off',
        task_id INTEGER,
        parent_session_id TEXT
      );
      CREATE TABLE session_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        role TEXT NOT NULL,
        message_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(session_id, seq)
      );
    `);

    const insertMigration = db.query("INSERT INTO migrations (name) VALUES (?)");
    for (const migrationName of PRE_RUNTIME_MIGRATIONS) {
      insertMigration.run(migrationName);
    }

    db.query(
      `INSERT INTO sessions (id, project_id, created_at, updated_at, thinking_level)
       VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'off')`,
    ).run("existing", 1);

    runMigrations(db);

    const existing = db.query<{ agent_runtime_type: string }, [string]>(
      "SELECT agent_runtime_type FROM sessions WHERE id = ?",
    ).get("existing");
    expect(existing?.agent_runtime_type).toBe("pi");

    db.query(
      `INSERT INTO sessions (id, project_id, created_at, updated_at, thinking_level)
       VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'off')`,
    ).run("new-session", 1);

    const created = db.query<{ agent_runtime_type: string }, [string]>(
      "SELECT agent_runtime_type FROM sessions WHERE id = ?",
    ).get("new-session");
    expect(created?.agent_runtime_type).toBe("pi");
  });
});


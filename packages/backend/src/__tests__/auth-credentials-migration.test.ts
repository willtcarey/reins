import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { randomBytes } from "crypto";
import { initEncryptionSecret, encrypt } from "../crypto.js";
import { runMigrations } from "../migrations.js";

initEncryptionSecret(randomBytes(32));

const PRE_015_MIGRATIONS = [
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
] as const;

describe("auth_credentials migration", () => {
  test("migrates legacy settings-backed auth rows into auth_credentials", () => {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(`
      CREATE TABLE migrations (
        name TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    for (const name of PRE_015_MIGRATIONS) {
      db.query("INSERT INTO migrations (name) VALUES (?)").run(name);
    }

    db.query("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)").run(
      "default_model",
      JSON.stringify({ provider: "anthropic", modelId: "claude", thinkingLevel: "high" }),
      "2026-04-05T10:00:00Z",
    );
    db.query("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)").run(
      "api_key_anthropic",
      encrypt("sk-ant-migrated"),
      "2026-04-05T10:01:00Z",
    );
    db.query("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)").run(
      "oauth_openai",
      encrypt(JSON.stringify({ refresh: "r", access: "a", expires: 123 })),
      "2026-04-05T10:02:00Z",
    );

    runMigrations(db);

    expect(
      db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM auth_credentials").get()!
        .count,
    ).toBe(2);

    expect(
      db.query<{ provider: string; type: string; value: string; updated_at: string }, [string, string]>(
        "SELECT provider, type, value, updated_at FROM auth_credentials WHERE provider = ? AND type = ?",
      ).get("anthropic", "api_key"),
    ).toEqual({
      provider: "anthropic",
      type: "api_key",
      value: expect.any(String),
      updated_at: "2026-04-05T10:01:00Z",
    });

    expect(
      db.query<{ provider: string; type: string; updated_at: string }, [string, string]>(
        "SELECT provider, type, updated_at FROM auth_credentials WHERE provider = ? AND type = ?",
      ).get("openai", "oauth"),
    ).toEqual({
      provider: "openai",
      type: "oauth",
      updated_at: "2026-04-05T10:02:00Z",
    });

    expect(
      db.query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM settings WHERE key = ?").get("default_model")!
        .count,
    ).toBe(1);
    expect(
      db.query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM settings WHERE key = ?").get("api_key_anthropic")!
        .count,
    ).toBe(0);
    expect(
      db.query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM settings WHERE key = ?").get("oauth_openai")!
        .count,
    ).toBe(0);
  });
});

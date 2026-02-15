/**
 * Database Migrations
 *
 * Append-only list of migrations. Each entry is [name, sql].
 * They run in order, once each, tracked in a `migrations` table.
 * Never modify or reorder existing entries — only append new ones.
 */

import type { Database } from "bun:sqlite";

const MIGRATIONS: [name: string, sql: string][] = [
  [
    "001_create_projects",
    `CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_opened_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  ],
  [
    "002_add_base_branch",
    "ALTER TABLE projects ADD COLUMN base_branch TEXT NOT NULL DEFAULT 'main'",
  ],
  [
    "003_create_sessions",
    `CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      model_provider TEXT,
      model_id TEXT,
      thinking_level TEXT DEFAULT 'off'
    )`,
  ],
  [
    "004_create_session_messages",
    `CREATE TABLE session_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      message_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(session_id, seq)
    )`,
  ],
  [
    "005_session_indexes",
    `CREATE INDEX idx_session_messages_session ON session_messages(session_id, seq);
     CREATE INDEX idx_sessions_project ON sessions(project_id, updated_at DESC)`,
  ],
  [
    "006_create_tasks",
    `CREATE TABLE tasks (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
       title TEXT NOT NULL,
       description TEXT,
       branch_name TEXT NOT NULL,
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       updated_at TEXT NOT NULL DEFAULT (datetime('now'))
     );
     CREATE INDEX idx_tasks_project ON tasks(project_id, updated_at DESC)`,
  ],
  [
    "007_add_session_task_id",
    `ALTER TABLE sessions ADD COLUMN task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE`,
  ],
];

export function runMigrations(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const applied = new Set(
    (db.query("SELECT name FROM migrations").all() as { name: string }[])
      .map((r) => r.name),
  );

  for (const [name, sql] of MIGRATIONS) {
    if (applied.has(name)) continue;
    db.exec(sql);
    db.query("INSERT INTO migrations (name) VALUES (?)").run(name);
    console.log(`  Migration applied: ${name}`);
  }
}

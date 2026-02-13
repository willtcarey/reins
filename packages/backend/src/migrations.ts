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

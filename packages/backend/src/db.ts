/**
 * Database
 *
 * Shared SQLite database instance. Lives at .reins/reins.db in the
 * workspace root. Lazily initialized on first access.
 */

import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "fs";
import { join } from "path";
import { runMigrations } from "./migrations.js";

const WORKSPACE_ROOT = process.cwd();
const DATA_DIR = join(WORKSPACE_ROOT, ".reins");
const DB_PATH = join(DATA_DIR, "reins.db");

let db: Database | null = null;

export function getDb(): Database {
  if (db) return db;

  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }

  db = new Database(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);

  return db;
}

/**
 * Replace the shared DB instance. Used by tests to inject an in-memory database.
 */
export function setDb(newDb: Database): void {
  db = newDb;
}

/**
 * Close and clear the shared DB instance. Used by test teardown.
 */
export function resetDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

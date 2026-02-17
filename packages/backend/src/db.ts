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

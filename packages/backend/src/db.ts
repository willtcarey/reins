/**
 * Database
 *
 * Shared SQLite database instance. Lives at .reins/reins.db in the
 * workspace root. Lazily initialized on first access.
 */

import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "fs";
import { join, resolve } from "path";
import { runMigrations } from "./migrations.js";

/**
 * Resolve the data directory from an env-like record.
 * - If REINS_DATA_DIR is set and non-empty, use it (resolved against cwd if relative).
 * - Otherwise fall back to .reins/ under cwd.
 */
export function resolveDataDir(
  env: Record<string, string | undefined> = process.env,
): string {
  const raw = env.REINS_DATA_DIR?.trim();
  if (raw) return resolve(raw);
  return join(process.cwd(), ".reins");
}

const DATA_DIR = resolveDataDir();
const DB_PATH = join(DATA_DIR, "reins.db");

let db: Database | null = null;
let injectedDb = false;
export function hasInjectedDb(): boolean { return injectedDb; }

export function getDb(): Database {
  if (db) return db;

  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }

  injectedDb = false;
  db = new Database(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
  // A process restart cannot prove admission for an interrupted open.
  // Do this once at database startup, never when installing a hot-reload handler.
  db.exec("UPDATE node_command_outbox SET state = 'unknown' WHERE state = 'dispatching'");

  return db;
}

/**
 * Replace the shared DB instance. Used by tests to inject an in-memory database.
 */
export function setDb(newDb: Database): void {
  injectedDb = true;
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
  injectedDb = false;
}

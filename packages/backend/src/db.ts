/**
 * Database
 *
 * Shared SQLite database instance. Lives at .reins/reins.db in the workspace root. The server process
 * owner (`server-process.ts`) opens it once at startup (`openDb`: migrations and outbox recovery) and
 * injects the handle into every handler module it loads (`setDb`), so a dev hot reload reuses the same
 * connection and never re-runs startup. Standalone tools that never call `setDb` open it lazily.
 */

import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "fs";
import { join, resolve } from "path";
import { runMigrations } from "./migrations.js";
import { recoverInterruptedDispatches } from "./node-command-recovery.js";
import { logger } from "./logger.js";

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

/**
 * Opens the database and runs process startup against it: migrations, then recovery of dispatches a
 * restart interrupted (requeued for redelivery). Once per process: a second run would requeue another
 * handler's in-flight deliveries, putting a second command of their session in flight.
 */
export function openDb(): Database {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }

  const opened = new Database(DB_PATH);
  opened.exec("PRAGMA journal_mode = WAL");
  opened.exec("PRAGMA foreign_keys = ON");
  runMigrations(opened);
  const recovered = recoverInterruptedDispatches(opened);
  logger.info(`  Database: ${DB_PATH} (${recovered} interrupted dispatch${recovered === 1 ? "" : "es"} recovered)`);
  return opened;
}

export function getDb(): Database {
  db ??= openDb();
  return db;
}

/**
 * Replace the shared DB instance: the process owner's handle in a loaded handler module, or a test's
 * in-memory database.
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

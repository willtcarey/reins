/**
 * Database
 *
 * The shared SQLite connection handler code reads (`getDb`). The server process opens it once
 * (`openDatabase` in `database.ts`) and hands it to every handler load, which makes it the one `getDb`
 * returns (`setDb`) and prepares it (`prepareDatabase`: migrations) when it starts;
 * no load closes it (ADR-029). Standalone tools that never call `setDb` open and prepare one lazily.
 */

import type { Database } from "bun:sqlite";
import { databasePath, openDatabase } from "./database.js";
import { runMigrations } from "./migrations.js";
import { logger } from "./logger.js";

let db: Database | null = null;

/** Runs a load's startup against the database: its migrations (only pending ones apply, so a new
 * migration takes effect on the next reload). */
export function prepareDatabase(prepared: Database): void {
  runMigrations(prepared);
  logger.info(`  Database: ${prepared.filename || databasePath()}`);
}

export function getDb(): Database {
  if (!db) {
    db = openDatabase();
    prepareDatabase(db);
  }
  return db;
}

/**
 * Replace the shared DB instance: the process's connection (`start` in `server.ts`), or a test's
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

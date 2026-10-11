/**
 * Database
 *
 * The shared SQLite connection handler code reads (`getDb`). The server process opens it once
 * (`openDatabase` in `database.ts`) and hands it to every handler load, which makes it the one `getDb`
 * returns (`setDb`) and prepares it (`prepareDatabase`: migrations, then outbox recovery) when it starts;
 * no load closes it (ADR-029). Standalone tools that never call `setDb` open and prepare one lazily.
 */

import type { Database } from "bun:sqlite";
import { databasePath, openDatabase } from "./database.js";
import { runMigrations } from "./migrations.js";
import { recoverInterruptedDispatches } from "./nodes/node-command-recovery.js";
import { logger } from "./logger.js";

let db: Database | null = null;

/**
 * Runs a load's startup against the database: migrations (only pending ones apply, so a new migration
 * takes effect on the next reload), then recovery of dispatches a restart or reload interrupted (requeued
 * for redelivery). Only when no other dispatcher is delivering (the previous handler load stopped):
 * recovery would requeue its in-flight deliveries, putting a second command of their session in flight.
 */
export function prepareDatabase(prepared: Database): void {
  runMigrations(prepared);
  const recovered = recoverInterruptedDispatches(prepared);
  logger.info(`  Database: ${prepared.filename || databasePath()} (${recovered} interrupted dispatch${recovered === 1 ? "" : "es"} recovered)`);
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

/**
 * Database
 *
 * The shared SQLite connection the stores read (`getDb`, the stores' way to the database), and the open
 * sessions the session store derives running sessions from (`getOpenSessions`). Both belong to the server
 * process (`ServerProcess.db`, `ServerProcess.sessions`), which opens the database once; each app, when
 * it starts, injects them here (`injectProcessState`), then prepares the database (`prepareDatabase`:
 * migrations); no app closes it (ADR-029). Standalone tools that never inject open and prepare a database
 * lazily, and have no open sessions: nothing runs.
 */

import type { Database } from "bun:sqlite";
import type { OpenSessions, ServerProcess } from "./state.js";
import { databasePath, openDatabase } from "./database.js";
import { runMigrations } from "./migrations.js";
import { logger } from "./logger.js";

let db: Database | null = null;
let sessions: OpenSessions | null = null;

/** Runs an app's startup against the database: its migrations (only pending ones apply, so a new
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
 * Injects the process's state (its database and open sessions) into this module, at an app's start
 * (`start` in `server.ts`). There is one `ServerProcess` for the life of the server, but each app is its
 * own bundle with its own copy of this module's state, so every app's start injects the same process
 * into its copy again. The process keeps owning both; the stores only reach them through here.
 */
export function injectProcessState(serverProcess: Pick<ServerProcess, "db" | "sessions">): void {
  setDb(serverProcess.db);
  useOpenSessions(serverProcess.sessions);
}

/** The open sessions the stores derive running sessions from (a test's process). */
export function useOpenSessions(openSessions: OpenSessions | null): void {
  sessions = openSessions;
}

/** The process's open sessions, or null where none were given (nothing runs). */
export function getOpenSessions(): OpenSessions | null {
  return sessions;
}

/**
 * Close and clear the shared DB instance (and the open sessions). Used by test teardown.
 */
export function resetDb(): void {
  sessions = null;
  if (db) {
    db.close();
    db = null;
  }
}

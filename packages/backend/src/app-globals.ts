/**
 * App globals: the app's module-level globals, each a part of the server process's state (`ServerProcess`,
 * ADR-029) that app code reaches without being passed the process. Stores and models read them from here
 * instead of taking the process as a parameter.
 *
 * There is one `ServerProcess` for the life of the server, but each app is its own bundle (a dev reload
 * builds a new one) with its own copy of this module, so every app's start (`start` in `server.ts`)
 * injects the same process into its copy again (`injectProcessState`). The process keeps owning what it
 * injects; nothing here closes or replaces it.
 *
 * What is here:
 * - the database connection (`getDb`), which the app's start migrates (`prepareDatabase`);
 * - the open sessions (`getOpenSessions`), from which the session store derives running sessions.
 *
 * Add here only process state that app code needs without a process at hand; anything else is passed as
 * `AppState.process`. Standalone tools that never inject get a lazily opened and migrated database and no
 * open sessions (nothing runs); tests inject their own (`setDb`, `useOpenSessions`, `resetDb`).
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

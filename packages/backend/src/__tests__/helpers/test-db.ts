/**
 * Test Database Helper
 *
 * Creates an in-memory SQLite database with all migrations applied.
 * Call setupTestDb() in beforeEach and teardownTestDb() in afterEach
 * for full isolation between tests.
 */

import { Database } from "bun:sqlite";
import { runMigrations } from "../../migrations.js";
import { setDb, resetDb } from "../../db.js";

export function setupTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
  setDb(db);
  return db;
}

export function teardownTestDb(): void {
  resetDb();
}

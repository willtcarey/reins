/**
 * Test Database Helper
 *
 * Creates an in-memory SQLite database with all migrations applied.
 * Use useTestDb() for automatic beforeEach/afterEach hooks,
 * or call setupTestDb()/teardownTestDb() individually.
 */

import { beforeEach, afterEach } from "bun:test";
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

export function useTestDb() {
  beforeEach(() => setupTestDb());
  afterEach(() => teardownTestDb());
}

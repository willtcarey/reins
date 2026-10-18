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
import { setDb, resetDb } from "../../app-globals.js";

let migratedTemplate: Buffer | null = null;

function getMigratedTemplate(): Buffer {
  if (migratedTemplate) return migratedTemplate;

  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
  migratedTemplate = Buffer.from(db.serialize());
  db.close();

  return migratedTemplate;
}

function openSerializedDatabase(serialized: Buffer): Database {
  // Bun accepts bytes returned by serialize(), but the current type only lists filenames.
  const db: Database = Reflect.construct(Database, [Buffer.from(serialized)]);
  return db;
}

export function setupTestDb(): Database {
  const db = openSerializedDatabase(getMigratedTemplate());
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  setDb(db);
  return db;
}

/** Work to finish before the test database closes (e.g. closing session runtimes, which commit as they
 * end): run once by the next `useTestDb` teardown. */
const beforeTeardown: Array<() => Promise<void> | void> = [];
export function onTestDbTeardown(cleanup: () => Promise<void> | void): void {
  beforeTeardown.push(cleanup);
}

export function teardownTestDb(): void {
  resetDb();
}

export function useTestDb() {
  beforeEach(() => setupTestDb());
  afterEach(async () => {
    for (const cleanup of beforeTeardown.splice(0)) await cleanup();
    teardownTestDb();
  });
}

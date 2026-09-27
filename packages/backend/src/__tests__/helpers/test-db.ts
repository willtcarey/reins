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
import { openNodeDb } from "@reins/node/storage";

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

let nodeDb: Database | undefined;
/** The node database in-process test nodes start on (`startNode(testNodeDb())`, e.g. the loopback node):
 * the one `setupTestDb()` opened, or one a test set with `setTestNodeDb`. */
export function testNodeDb(): Database {
  if (!nodeDb) throw new Error("No test node database: call setupTestDb() or setTestNodeDb()");
  return nodeDb;
}
/** Replaces the test node database; the caller owns `db`. Nodes already started keep theirs. */
export function setTestNodeDb(db?: Database): void { nodeDb = db; }
export function closeTestNodeDb(): void { nodeDb?.close(); nodeDb = undefined; }

export function setupTestDb(): Database {
  const db = openSerializedDatabase(getMigratedTemplate());
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  setDb(db);
  setTestNodeDb(openNodeDb(":memory:"));
  return db;
}

export function teardownTestDb(): void {
  resetDb();
  closeTestNodeDb();
}

export function useTestDb() {
  beforeEach(() => setupTestDb());
  afterEach(() => teardownTestDb());
}

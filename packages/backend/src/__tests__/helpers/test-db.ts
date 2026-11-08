/**
 * Test Database Helper
 *
 * Creates an in-memory SQLite database with all migrations applied, and the extensions' data (their
 * directories and databases, `testExtensionData`) in a temporary directory of the test's own.
 * Use useTestDb() for automatic beforeEach/afterEach hooks,
 * or call setupTestDb()/teardownTestDb() individually.
 */

import { beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runMigrations } from "../../migrations.js";
import { setDb, resetDb } from "../../app-globals.js";
import { openExtensionData, type ExtensionData } from "../../database.js";

let migratedTemplate: Buffer | null = null;
let extensions: { dir: string; data: ExtensionData & { close(): void } } | null = null;

/** The extensions' data of the current test, as the process has it (`ServerProcess.extensionData`):
 * created at first use, closed and removed at teardown. */
export function testExtensionData(): ExtensionData {
  if (!extensions) {
    const dir = join(mkdtempSync(join(tmpdir(), "reins-test-")), "extensions");
    extensions = { dir, data: openExtensionData(dir) };
  }
  return extensions.data;
}

/** The directory the current test's extensions' directories are in (`<data dir>/extensions`). */
export function testExtensionsDir(): string {
  testExtensionData();
  return extensions!.dir;
}

/** Where the current test's added extensions' built files are copied (`<data dir>/extension-builds`). */
export function testExtensionBuildsDir(): string {
  return testExtensionData().buildsDir;
}

/** An extension's own database in the current test (MCP's tables are in `mcp`'s). */
export function extensionDb(name: string): Database {
  return testExtensionData().open(name).db;
}

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
  if (extensions) {
    extensions.data.close();
    rmSync(join(extensions.dir, ".."), { recursive: true, force: true });
    extensions = null;
  }
}

export function useTestDb() {
  beforeEach(() => setupTestDb());
  afterEach(async () => {
    for (const cleanup of beforeTeardown.splice(0)) await cleanup();
    teardownTestDb();
  });
}

/**
 * The product database's file and how a connection to it is opened. The server process opens it once
 * and hands the connection to every app (`ServerProcess.db`, ADR-029); standalone tools open their own (`getDb` in
 * `db.ts`). Also each backend extension's directory and database (`openExtensionData`, ADR-032), which the
 * process opens the same way. Process owner code: a change needs a restart.
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "fs";
import { dirname, join, resolve } from "path";

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

/** The database's path: `reins.db` in the data directory. */
export function databasePath(): string {
  return join(resolveDataDir(), "reins.db");
}

/** The directory each backend extension's own directory is in: `<data dir>/extensions`. */
export function extensionsDir(): string {
  return join(resolveDataDir(), "extensions");
}

/** A backend extension's own place: its directory and the database in it. */
export interface ExtensionStorage {
  /** `<extensions dir>/<name>`, absolute. */
  readonly dataDir: string;
  /** `<dataDir>/db.sqlite`, opened as the main database is (`openDatabase`). */
  readonly db: Database;
}

/** Each backend extension's directory and database, which the process opens once and keeps for its life,
 * so that every app (each reload) gets the same connection. Nothing is ever deleted. */
export interface ExtensionData {
  /** The extension's storage: its directory created and its database opened at the first call, the same
   * after. `name` is an extension's name (`[a-z][a-z0-9-]*`); another throws. */
  open(name: string): ExtensionStorage;
  /** Where added extensions' built files are copied: beside the extensions' directories, not in them, since
   * those are the extensions' own. */
  readonly buildsDir: string;
}

const EXTENSION_NAME = /^[a-z][a-z0-9-]*$/;

/** The extensions' storage under `root`; `close` closes the databases it opened (tests: the process
 * never closes them). */
export function openExtensionData(root = extensionsDir()): ExtensionData & { close(): void } {
  const opened = new Map<string, ExtensionStorage>();
  return {
    buildsDir: join(dirname(resolve(root)), "extension-builds"),
    open(name) {
      if (!EXTENSION_NAME.test(name)) throw new Error(`Not an extension name: ${name}`);
      let storage = opened.get(name);
      if (!storage) {
        const dataDir = resolve(root, name);
        mkdirSync(dataDir, { recursive: true });
        storage = { dataDir, db: openDatabase(join(dataDir, "db.sqlite")) };
        opened.set(name, storage);
      }
      return storage;
    },
    close() {
      for (const { db } of opened.values()) db.close();
      opened.clear();
    },
  };
}

/** Opens the database (creating its directory) with the pragmas every connection uses. Nothing else:
 * whoever serves on it runs the migrations (`prepareDatabase` in `db.ts`). */
export function openDatabase(path = databasePath()): Database {
  const dir = resolve(path, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

/**
 * The product database's file and how a connection to it is opened. The server process opens it once
 * and hands the connection to every app (`ServerProcess.db`, ADR-029); standalone tools open their own (`getDb` in
 * `db.ts`). Process owner code: a change needs a restart.
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "fs";
import { join, resolve } from "path";

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

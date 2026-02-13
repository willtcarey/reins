/**
 * Project Store
 *
 * SQLite-backed persistence for Herald projects.
 * Each project is a name + directory path mapping.
 * Database lives at .herald/herald.db in the workspace root.
 */

import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "fs";
import { join, resolve } from "path";

export interface Project {
  id: number;
  name: string;
  path: string;
  created_at: string;
  last_opened_at: string;
}

// Resolve .herald/ relative to the workspace root (two levels up from src/)
const WORKSPACE_ROOT = resolve(import.meta.dirname!, "../../..");
const HERALD_DIR = join(WORKSPACE_ROOT, ".herald");
const DB_PATH = join(HERALD_DIR, "herald.db");

let db: Database | null = null;

function getDb(): Database {
  if (db) return db;

  if (!existsSync(HERALD_DIR)) {
    mkdirSync(HERALD_DIR, { recursive: true });
  }

  db = new Database(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_opened_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  return db;
}

export function listProjects(): Project[] {
  const d = getDb();
  return d.query("SELECT * FROM projects ORDER BY last_opened_at DESC").all() as Project[];
}

export function getProject(id: number): Project | null {
  const d = getDb();
  return (d.query("SELECT * FROM projects WHERE id = ?").get(id) as Project) ?? null;
}

export function createProject(name: string, path: string): Project {
  const d = getDb();
  const result = d.query("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING *").get(name, path) as Project;
  return result;
}

export function updateProject(id: number, updates: { name?: string; path?: string }): Project | null {
  const d = getDb();
  const existing = getProject(id);
  if (!existing) return null;

  const name = updates.name ?? existing.name;
  const path = updates.path ?? existing.path;
  d.query("UPDATE projects SET name = ?, path = ? WHERE id = ?").run(name, path, id);
  return getProject(id);
}

export function deleteProject(id: number): boolean {
  const d = getDb();
  const result = d.query("DELETE FROM projects WHERE id = ?").run(id);
  return result.changes > 0;
}

export function touchProject(id: number): void {
  const d = getDb();
  d.query("UPDATE projects SET last_opened_at = datetime('now') WHERE id = ?").run(id);
}

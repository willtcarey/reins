/**
 * Project Store
 *
 * SQLite-backed persistence for projects: a name, a base branch and a default
 * source (where it was created: a location on a node, `node-store.ts`).
 * Database lives at .reins/reins.db in the workspace root.
 *
 * Schema is managed by migrations.ts — see that file to add new columns.
 */

import { getDb } from "./app-globals.js";

export interface Project {
  id: number;
  name: string;
  base_branch: string;
  /** Its default source: where it was created, where a session with nothing better to inherit works. */
  default_source_id: number | null;
  created_at: string;
  last_opened_at: string;
}

// ---- CRUD ------------------------------------------------------------------

export function listProjects(): Project[] {
  const d = getDb();
  return d.query<Project, []>("SELECT * FROM projects ORDER BY last_opened_at DESC").all();
}

export function getProject(id: number): Project | null {
  const d = getDb();
  return d.query<Project, [number]>("SELECT * FROM projects WHERE id = ?").get(id) ?? null;
}

export function createProject(name: string, baseBranch: string, defaultSourceId: number): Project {
  const d = getDb();
  const result = d.query<Project, [string, string, number]>("INSERT INTO projects (name, base_branch, default_source_id, created_at, last_opened_at) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) RETURNING *").get(name, baseBranch, defaultSourceId);
  if (!result) throw new Error("Failed to create project");
  return result;
}

export function updateProject(id: number, updates: { name?: string; base_branch?: string; default_source_id?: number }): Project | null {
  const d = getDb();
  const existing = getProject(id);
  if (!existing) return null;

  const name = updates.name ?? existing.name;
  const baseBranch = updates.base_branch ?? existing.base_branch;
  const defaultSourceId = updates.default_source_id ?? existing.default_source_id;
  d.query("UPDATE projects SET name = ?, base_branch = ?, default_source_id = ? WHERE id = ?").run(name, baseBranch, defaultSourceId, id);
  return getProject(id);
}

export function deleteProject(id: number): boolean {
  const d = getDb();
  const result = d.query("DELETE FROM projects WHERE id = ?").run(id);
  return result.changes > 0;
}

export function touchProject(id: number): void {
  const d = getDb();
  d.query("UPDATE projects SET last_opened_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(id);
}

/**
 * Project Store
 *
 * SQLite-backed persistence for projects.
 * A project is its name, base branch and path: the path of its first source
 * (a checkout on a node, `sources`), which is created with it.
 * Database lives at .reins/reins.db in the workspace root.
 *
 * Schema is managed by migrations.ts — see that file to add new columns.
 */

import { getDb } from "./db.js";

export interface Project {
  id: number;
  name: string;
  path: string;
  base_branch: string;
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

/** Creates a project and its first source: the checkout at `path` on node `nodeId`. */
export function createProject(name: string, path: string, baseBranch: string, nodeId: string): Project {
  const d = getDb();
  return d.transaction(() => {
    const result = d.query<Project, [string, string, string]>("INSERT INTO projects (name, path, base_branch, created_at, last_opened_at) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) RETURNING *").get(name, path, baseBranch);
    if (!result) throw new Error("Failed to create project");
    d.query("INSERT INTO sources (project_id, node_id, path) VALUES (?, ?, ?)").run(result.id, nodeId, path);
    return result;
  })();
}

export function updateProject(id: number, updates: { name?: string; path?: string; base_branch?: string }): Project | null {
  const d = getDb();
  const existing = getProject(id);
  if (!existing) return null;

  const name = updates.name ?? existing.name;
  const path = updates.path ?? existing.path;
  const baseBranch = updates.base_branch ?? existing.base_branch;
  d.transaction(() => {
    d.query("UPDATE projects SET name = ?, path = ?, base_branch = ? WHERE id = ?").run(name, path, baseBranch, id);
    // The project's path is its first source's.
    d.query("UPDATE sources SET path = ? WHERE id = (SELECT id FROM sources WHERE project_id = ? ORDER BY id LIMIT 1)").run(path, id);
  })();
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

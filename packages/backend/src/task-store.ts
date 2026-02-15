/**
 * Task Store
 *
 * SQLite-backed persistence for tasks.
 * Tasks represent units of work on a project, each with a dedicated git branch.
 */

import { getDb } from "./db.js";

// ---- Types -----------------------------------------------------------------

export interface TaskRow {
  id: number;
  project_id: number;
  title: string;
  description: string | null;
  branch_name: string;
  created_at: string;
  updated_at: string;
}

export interface TaskListItem extends TaskRow {
  session_count: number;
}

// ---- CRUD ------------------------------------------------------------------

export function createTask(
  projectId: number,
  title: string,
  description: string | null,
  branchName: string,
): TaskRow {
  const db = getDb();
  return db
    .query(
      `INSERT INTO tasks (project_id, title, description, branch_name)
       VALUES (?, ?, ?, ?)
       RETURNING *`,
    )
    .get(projectId, title, description, branchName) as TaskRow;
}

export function getTask(id: number): TaskRow | null {
  const db = getDb();
  return (db.query("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow) ?? null;
}

export function listTasks(projectId: number): TaskListItem[] {
  const db = getDb();
  return db
    .query(
      `SELECT
         t.*,
         COALESCE(sc.cnt, 0) AS session_count
       FROM tasks t
       LEFT JOIN (
         SELECT task_id, COUNT(*) AS cnt
         FROM sessions
         WHERE task_id IS NOT NULL
         GROUP BY task_id
       ) sc ON sc.task_id = t.id
       WHERE t.project_id = ?
       ORDER BY t.updated_at DESC`,
    )
    .all(projectId) as TaskListItem[];
}

export function updateTask(
  id: number,
  updates: { title?: string; description?: string },
): TaskRow | null {
  const db = getDb();
  const existing = getTask(id);
  if (!existing) return null;

  const title = updates.title ?? existing.title;
  const description = updates.description !== undefined ? updates.description : existing.description;

  db.query(
    `UPDATE tasks SET title = ?, description = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(title, description, id);

  return getTask(id);
}

export function touchTask(id: number): void {
  const db = getDb();
  db.query("UPDATE tasks SET updated_at = datetime('now') WHERE id = ?").run(id);
}

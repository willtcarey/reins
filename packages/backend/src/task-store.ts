/**
 * Task Store
 *
 * SQLite-backed persistence for tasks.
 * Tasks represent units of work on a project, each with a dedicated git branch.
 */

import { getDb } from "./db.js";

// ---- Types -----------------------------------------------------------------

export type TaskStatus = "open" | "closed";

export interface TaskRow {
  id: number;
  project_id: number;
  title: string;
  description: string | null;
  branch_name: string;
  base_commit: string | null;
  status: TaskStatus;
  created_at: string;
  updated_at: string;
}

export interface TaskListItem extends TaskRow {
  session_count: number;
  session_ids: string[];
}

// ---- CRUD ------------------------------------------------------------------

export function createTask(
  projectId: number,
  title: string,
  description: string | null,
  branchName: string,
  baseCommit: string | null = null,
): TaskRow {
  const db = getDb();
  return db
    .query(
      `INSERT INTO tasks (project_id, title, description, branch_name, base_commit, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       RETURNING *`,
    )
    .get(projectId, title, description, branchName, baseCommit) as TaskRow;
}

export function getTask(id: number): TaskRow | null {
  const db = getDb();
  return (db.query("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow) ?? null;
}

export function listTasks(projectId: number): TaskListItem[] {
  const db = getDb();
  const rows = db
    .query(
      `SELECT
         t.*,
         COALESCE(sc.cnt, 0) AS session_count,
         COALESCE(sc.ids, '[]') AS session_ids_json
       FROM tasks t
       LEFT JOIN (
         SELECT task_id, COUNT(*) AS cnt,
                json_group_array(id) AS ids
         FROM sessions
         WHERE task_id IS NOT NULL
         GROUP BY task_id
       ) sc ON sc.task_id = t.id
       WHERE t.project_id = ?
       ORDER BY CASE t.status WHEN 'closed' THEN 1 ELSE 0 END, t.updated_at DESC`,
    )
    .all(projectId) as (TaskRow & { session_count: number; session_ids_json: string })[];

  return rows.map(({ session_ids_json, ...rest }) => ({
    ...rest,
    session_ids: JSON.parse(session_ids_json),
  }));
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
    `UPDATE tasks SET title = ?, description = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
  ).run(title, description, id);

  return getTask(id);
}

export function touchTask(id: number): void {
  const db = getDb();
  db.query("UPDATE tasks SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(id);
}

/**
 * Delete a task and all its associated sessions + messages.
 * Returns true if the task was found and deleted, false otherwise.
 */
export function deleteTask(id: number): boolean {
  const db = getDb();
  const task = getTask(id);
  if (!task) return false;

  const tx = db.transaction(() => {
    // Delete messages for all sessions belonging to this task
    db.query(
      `DELETE FROM session_messages WHERE session_id IN
       (SELECT id FROM sessions WHERE task_id = ?)`,
    ).run(id);
    // Delete sessions belonging to this task
    db.query("DELETE FROM sessions WHERE task_id = ?").run(id);
    // Delete the task itself
    db.query("DELETE FROM tasks WHERE id = ?").run(id);
  });
  tx();

  return true;
}

/**
 * Mark the given tasks as closed. One-way latch — once closed, always closed.
 */
export function markTasksClosed(taskIds: number[]): void {
  if (taskIds.length === 0) return;
  const db = getDb();
  const placeholders = taskIds.map(() => "?").join(", ");
  db.query(
    `UPDATE tasks SET status = 'closed', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id IN (${placeholders}) AND status = 'open'`,
  ).run(...taskIds);
}

/**
 * List open tasks for a project — used for merge reconciliation.
 */
export function listOpenTasks(projectId: number): TaskRow[] {
  const db = getDb();
  return db
    .query("SELECT * FROM tasks WHERE project_id = ? AND status = 'open'")
    .all(projectId) as TaskRow[];
}

/**
 * Get the IDs of all sessions belonging to a task.
 */
export function getTaskSessionIds(taskId: number): string[] {
  const db = getDb();
  const rows = db
    .query("SELECT id FROM sessions WHERE task_id = ?")
    .all(taskId) as { id: string }[];
  return rows.map((r) => r.id);
}

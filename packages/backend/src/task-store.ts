/**
 * Task Store
 *
 * SQLite-backed persistence for tasks.
 * Tasks represent units of work on a project, each with a dedicated git branch.
 */

import { getDb } from "./db.js";

// ---- Types -----------------------------------------------------------------

export type TaskStatus = "open" | "closed";

/** A task is closed exactly while it has a `closed_at`; its status is derived from that. */
const STATUS_SQL = "CASE WHEN closed_at IS NULL THEN 'open' ELSE 'closed' END AS status";

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
  /** When the task last closed; null while open. */
  closed_at: string | null;
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
    .query<TaskRow, [number, string, string | null, string, string | null]>(
      `INSERT INTO tasks (project_id, title, description, branch_name, base_commit, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       RETURNING *, ${STATUS_SQL}`,
    )
    .get(projectId, title, description, branchName, baseCommit)!;
}

export function getTask(id: number): TaskRow | null {
  const db = getDb();
  return db.query<TaskRow, [number]>(`SELECT *, ${STATUS_SQL} FROM tasks WHERE id = ?`).get(id) ?? null;
}

export interface TaskListOptions {
  limit?: number;
  offset?: number;
  search?: string;
}

export function listTasks(
  projectId: number,
  status?: TaskStatus,
  options: TaskListOptions = {},
): TaskListItem[] {
  const db = getDb();
  const filters: string[] = [];
  const params: (number | string)[] = [projectId];
  if (status) filters.push(status === "closed" ? "t.closed_at IS NOT NULL" : "t.closed_at IS NULL");
  if (options.search?.trim()) {
    filters.push("(t.title LIKE ? OR t.description LIKE ?)");
    const pattern = `%${options.search.trim()}%`;
    params.push(pattern, pattern);
  }
  const filterSql = filters.length > 0 ? `AND ${filters.join(" AND ")}` : "";
  const rows = db
    .query<TaskRow & { session_count: number; session_ids_json: string }, (number | string)[]>(
      `SELECT
         t.*,
         ${STATUS_SQL},
         COALESCE(sc.cnt, 0) AS session_count,
         COALESCE(sc.ids, '[]') AS session_ids_json
       FROM tasks t
       LEFT JOIN (
         SELECT task_id, COUNT(*) AS cnt,
                json_group_array(id) AS ids
         FROM sessions
         WHERE task_id IS NOT NULL AND background = 0
         GROUP BY task_id
       ) sc ON sc.task_id = t.id
       WHERE t.project_id = ? ${filterSql}
       ORDER BY t.closed_at IS NOT NULL, t.updated_at DESC
       ${options.limit === undefined ? "" : "LIMIT ? OFFSET ?"}`,
    )
    .all(...params, ...(options.limit === undefined ? [] : [options.limit, options.offset ?? 0]));

  return rows.map(({ session_ids_json, ...rest }) => ({
    ...rest,
    session_ids: JSON.parse(session_ids_json),
  }));
}

export function updateTask(
  id: number,
  updates: { title?: string; description?: string | null; base_commit?: string },
): TaskRow | null {
  const db = getDb();
  const existing = getTask(id);
  if (!existing) return null;

  const title = updates.title ?? existing.title;
  const description = updates.description !== undefined ? updates.description : existing.description;
  const baseCommit = updates.base_commit !== undefined ? updates.base_commit : existing.base_commit;

  db.query(
    `UPDATE tasks SET title = ?, description = ?, base_commit = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
  ).run(title, description, baseCommit, id);

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
 * Close or reopen a task: closing records `closed_at` (kept if already closed), reopening clears it.
 * Returns the updated row, or null if not found.
 */
export function setTaskStatus(id: number, status: TaskStatus): TaskRow | null {
  const db = getDb();
  const task = getTask(id);
  if (!task) return null;
  db.query(
    `UPDATE tasks SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       closed_at = CASE WHEN ?1 = 'closed' THEN COALESCE(closed_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) END WHERE id = ?2`,
  ).run(status, id);
  return getTask(id);
}

/**
 * Get the IDs of all sessions belonging to a task.
 */
export function getTaskSessionIds(taskId: number): string[] {
  const db = getDb();
  const rows = db
    .query<{ id: string }, [number]>("SELECT id FROM sessions WHERE task_id = ?")
    .all(taskId);
  return rows.map((r) => r.id);
}

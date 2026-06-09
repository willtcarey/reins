/**
 * Session Store
 *
 * SQLite-backed persistence for agent session metadata. Sessions are linked to
 * projects by FK; transcript/message persistence lives in messages-store.ts.
 */

import { getDb } from "./db.js";
import { stripLeadingSkillBlocks } from "./models/skill.js";

// ---- Types -----------------------------------------------------------------

export type ActivityStateValue = "running" | "finished";

export interface SessionRow {
  id: string;
  project_id: number;
  name: string | null;
  created_at: string;
  updated_at: string;
  model_provider: string | null;
  model_id: string | null;
  thinking_level: string;
  agent_runtime_type: string;
  task_id: number | null;
  parent_session_id: string | null;
  activity_state: ActivityStateValue | null;
  /** Present on list/query rows that join session message metadata. */
  message_count?: number;
  /** Present on list/query rows that join the first user-message preview. */
  first_message?: string | null;
}

export interface SessionListOptions {
  /** Required unless listing sessions for a specific numeric taskId. */
  projectId?: number;
  /**
   * `undefined` means use `includeTaskSessions` to decide scope.
   * `null` means scratch sessions only.
   * A number means sessions for that task only.
   */
  taskId?: number | null;
  /** When taskId is undefined, include task sessions as well as scratch sessions. */
  includeTaskSessions?: boolean;
  since?: string;
  limit?: number;
  search?: string;
  minMessages?: number;
}

export interface PaletteItem {
  sessionId: string;
  projectId: number;
  projectName: string;
  taskId: number | null;
  taskTitle: string | null;
  firstMessage: string | null;
  updatedAt: string;
}

const MESSAGE_COUNT_BY_SESSION_SQL =
  "SELECT session_id, COUNT(*) AS cnt FROM session_messages GROUP BY session_id";

const FIRST_USER_MESSAGE_BY_SESSION_SQL = `SELECT session_id,
  json_extract(message_json, '$.content[0].text') AS first_message
FROM session_messages
WHERE role = 'user'
  AND seq = (SELECT MIN(seq) FROM session_messages sm2 WHERE sm2.session_id = session_messages.session_id AND sm2.role = 'user')`;

// ---- Session CRUD ----------------------------------------------------------

export function createSession(
  id: string,
  projectId: number,
  opts: {
    modelProvider?: string;
    modelId?: string;
    thinkingLevel?: string;
    agentRuntimeType: string;
    taskId?: number;
    parentSessionId?: string;
  },
): SessionRow {
  const db = getDb();
  return db
    .query<SessionRow, [string, number, string | null, string | null, string, string, number | null, string | null]>(
      `INSERT INTO sessions (id, project_id, model_provider, model_id, thinking_level, agent_runtime_type, task_id, parent_session_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       RETURNING *`,
    )
    .get(
      id,
      projectId,
      opts.modelProvider ?? null,
      opts.modelId ?? null,
      opts.thinkingLevel ?? "off",
      opts.agentRuntimeType,
      opts.taskId ?? null,
      opts.parentSessionId ?? null,
    )!;
}

export function getSession(id: string): SessionRow | null {
  const db = getDb();
  return db.query<SessionRow, [string]>("SELECT * FROM sessions WHERE id = ?").get(id) ?? null;
}

export function deleteSession(id: string): void {
  const db = getDb();
  db.query("DELETE FROM sessions WHERE id = ?").run(id);
}

/**
 * List sessions for UI and scripting/analysis. Supports message-count metadata
 * and filters without loading full transcripts into the agent context.
 */
export function listSessions(options: SessionListOptions): SessionRow[] {
  if (options.projectId === undefined && (options.taskId === undefined || options.taskId === null)) {
    throw new Error("projectId or numeric taskId must be provided");
  }

  const db = getDb();
  const where: string[] = [];
  const binds: (string | number)[] = [];

  if (options.projectId !== undefined) {
    where.push("s.project_id = ?");
    binds.push(options.projectId);
  }

  if (options.taskId === null) {
    where.push("s.task_id IS NULL");
  } else if (options.taskId !== undefined) {
    where.push("s.task_id = ?");
    binds.push(options.taskId);
  } else if (!options.includeTaskSessions) {
    where.push("s.task_id IS NULL");
  }

  if (options.since) {
    where.push("s.updated_at >= ?");
    binds.push(options.since);
  }

  if (options.search?.trim()) {
    const pattern = `%${options.search.trim()}%`;
    where.push(
      `(s.id LIKE ? OR s.name LIKE ? OR EXISTS (
         SELECT 1 FROM session_messages sm
         WHERE sm.session_id = s.id AND sm.message_json LIKE ?
       ))`,
    );
    binds.push(pattern, pattern, pattern);
  }

  if (options.minMessages !== undefined) {
    where.push("COALESCE(mc.cnt, 0) >= ?");
    binds.push(options.minMessages);
  }

  let sql = `SELECT
       s.*,
       COALESCE(mc.cnt, 0) AS message_count,
       fm.first_message
     FROM sessions s
     LEFT JOIN (${MESSAGE_COUNT_BY_SESSION_SQL}) mc ON mc.session_id = s.id
     LEFT JOIN (${FIRST_USER_MESSAGE_BY_SESSION_SQL}) fm ON fm.session_id = s.id
     WHERE ${where.join(" AND ")}
     ORDER BY s.updated_at DESC`;

  if (options.limit !== undefined) {
    sql += " LIMIT ?";
    binds.push(options.limit);
  }

  return db
    .query<SessionRow, (string | number)[]>(sql)
    .all(...binds)
    .map((r) => ({ ...r, first_message: stripLeadingSkillBlocks(r.first_message ?? null) }));
}

export function listPaletteItems(): PaletteItem[] {
  const db = getDb();
  const rows = db
    .query<PaletteItem, []>(
      `SELECT
         s.id AS sessionId,
         s.project_id AS projectId,
         p.name AS projectName,
         s.task_id AS taskId,
         t.title AS taskTitle,
         fm.first_message AS firstMessage,
         s.updated_at AS updatedAt
       FROM sessions s
       JOIN projects p ON p.id = s.project_id
       LEFT JOIN tasks t ON t.id = s.task_id
       JOIN (${MESSAGE_COUNT_BY_SESSION_SQL}) mc ON mc.session_id = s.id
       LEFT JOIN (${FIRST_USER_MESSAGE_BY_SESSION_SQL}) fm ON fm.session_id = s.id
       WHERE s.parent_session_id IS NULL
         AND mc.cnt > 0
         AND (
           s.task_id IS NOT NULL
           OR s.id = (
             SELECT s2.id FROM sessions s2
             JOIN (SELECT session_id FROM session_messages GROUP BY session_id) mc2
               ON mc2.session_id = s2.id
             WHERE s2.project_id = s.project_id
               AND s2.task_id IS NULL
               AND s2.parent_session_id IS NULL
             ORDER BY s2.updated_at DESC
             LIMIT 1
           )
         )
       ORDER BY s.updated_at DESC`,
    )
    .all();
  return rows.map((r) => ({ ...r, firstMessage: stripLeadingSkillBlocks(r.firstMessage) }));
}

export function updateSessionMeta(
  id: string,
  updates: {
    name?: string;
    modelProvider?: string;
    modelId?: string;
    thinkingLevel?: string;
    agentRuntimeType?: string;
  },
): void {
  const db = getDb();
  const session = getSession(id);
  if (!session) return;

  db.query(
    `UPDATE sessions
     SET name = ?, model_provider = ?, model_id = ?, thinking_level = ?, agent_runtime_type = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ?`,
  ).run(
    updates.name ?? session.name,
    updates.modelProvider ?? session.model_provider,
    updates.modelId ?? session.model_id,
    updates.thinkingLevel ?? session.thinking_level,
    updates.agentRuntimeType ?? session.agent_runtime_type,
    id,
  );
}

/**
 * Update the activity_state of a session. Used by the persistence observer
 * to persist running/finished state server-side.
 */
export function updateActivityState(
  id: string,
  activityState: ActivityStateValue | null,
): void {
  const db = getDb();
  db.query("UPDATE sessions SET activity_state = ? WHERE id = ?").run(activityState, id);
}

/**
 * Clear finished activity for all sessions belonging to the given tasks.
 * Running activity is preserved so active work remains visible.
 * Returns the session IDs that changed so callers can broadcast reconciliation.
 */
export function clearFinishedActivityForTasks(taskIds: number[]): string[] {
  if (taskIds.length === 0) return [];

  const db = getDb();
  const placeholders = taskIds.map(() => "?").join(", ");
  const rows = db
    .query<{ id: string }, number[]>(
      `SELECT id FROM sessions
       WHERE task_id IN (${placeholders}) AND activity_state = 'finished'
       ORDER BY id`,
    )
    .all(...taskIds);

  if (rows.length === 0) return [];

  const sessionIds = rows.map((row) => row.id);
  const sessionPlaceholders = sessionIds.map(() => "?").join(", ");
  db.query(
    `UPDATE sessions SET activity_state = NULL
     WHERE id IN (${sessionPlaceholders})`,
  ).run(...sessionIds);

  return sessionIds;
}

/**
 * List all sessions with non-null activity_state. Used to build an
 * initial activity snapshot for newly-connected WebSocket clients.
 */
export function listActiveSessions(): { id: string; activity_state: ActivityStateValue; project_id: number }[] {
  const db = getDb();
  return db
    .query<{ id: string; activity_state: ActivityStateValue; project_id: number }, []>(
      "SELECT id, activity_state, project_id FROM sessions WHERE activity_state IS NOT NULL",
    )
    .all();
}



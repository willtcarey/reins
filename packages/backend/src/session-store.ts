/**
 * Session Store
 *
 * SQLite-backed persistence for agent sessions and their messages.
 * Bridges pi's in-memory AgentSession with our relational storage.
 *
 * Sessions are linked to projects by FK. Messages are stored as JSON
 * blobs ordered by sequence number.
 */

import { getDb } from "./db.js";
import { stripLeadingSkillBlocks } from "./models/skill.js";

// ---- Types -----------------------------------------------------------------

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
}

export interface SessionListItem {
  id: string;
  name: string | null;
  created_at: string;
  updated_at: string;
  message_count: number;
  first_message: string | null;
  parent_session_id: string | null;
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

export interface SessionMessageRow {
  id: number;
  session_id: string;
  seq: number;
  role: string;
  message_json: string;
  created_at: string;
}

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

export function listSessions(projectId: number): SessionListItem[] {
  const db = getDb();
  return db
    .query<SessionListItem, [number]>(
      `SELECT
         s.id,
         s.name,
         s.created_at,
         s.updated_at,
         COALESCE(mc.cnt, 0) AS message_count,
         fm.first_message,
         s.parent_session_id
       FROM sessions s
       LEFT JOIN (
         SELECT session_id, COUNT(*) AS cnt FROM session_messages GROUP BY session_id
       ) mc ON mc.session_id = s.id
       LEFT JOIN (
         SELECT session_id,
           json_extract(message_json, '$.content[0].text') AS first_message
         FROM session_messages
         WHERE role = 'user'
           AND seq = (SELECT MIN(seq) FROM session_messages sm2 WHERE sm2.session_id = session_messages.session_id AND sm2.role = 'user')
       ) fm ON fm.session_id = s.id
       WHERE s.project_id = ? AND s.task_id IS NULL
       ORDER BY s.updated_at DESC`,
    )
    .all(projectId)
    .map((r) => ({ ...r, first_message: stripLeadingSkillBlocks(r.first_message) }));
}

export function listTaskSessions(taskId: number): SessionListItem[] {
  const db = getDb();
  return db
    .query<SessionListItem, [number]>(
      `SELECT
         s.id,
         s.name,
         s.created_at,
         s.updated_at,
         COALESCE(mc.cnt, 0) AS message_count,
         fm.first_message,
         s.parent_session_id
       FROM sessions s
       LEFT JOIN (
         SELECT session_id, COUNT(*) AS cnt FROM session_messages GROUP BY session_id
       ) mc ON mc.session_id = s.id
       LEFT JOIN (
         SELECT session_id,
           json_extract(message_json, '$.content[0].text') AS first_message
         FROM session_messages
         WHERE role = 'user'
           AND seq = (SELECT MIN(seq) FROM session_messages sm2 WHERE sm2.session_id = session_messages.session_id AND sm2.role = 'user')
       ) fm ON fm.session_id = s.id
       WHERE s.task_id = ?
       ORDER BY s.updated_at DESC`,
    )
    .all(taskId)
    .map((r) => ({ ...r, first_message: stripLeadingSkillBlocks(r.first_message) }));
}

export function listSessionRows(projectId: number): SessionRow[] {
  const db = getDb();
  return db
    .query<SessionRow, [number]>(
      `SELECT * FROM sessions WHERE project_id = ? AND task_id IS NULL ORDER BY updated_at DESC`,
    )
    .all(projectId);
}

export function listTaskSessionRows(taskId: number): SessionRow[] {
  const db = getDb();
  return db
    .query<SessionRow, [number]>(
      `SELECT * FROM sessions WHERE task_id = ? ORDER BY updated_at DESC`,
    )
    .all(taskId);
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
       JOIN (
         SELECT session_id, COUNT(*) AS cnt FROM session_messages GROUP BY session_id
       ) mc ON mc.session_id = s.id
       LEFT JOIN (
         SELECT session_id,
           json_extract(message_json, '$.content[0].text') AS first_message
         FROM session_messages
         WHERE role = 'user'
           AND seq = (SELECT MIN(seq) FROM session_messages sm2 WHERE sm2.session_id = session_messages.session_id AND sm2.role = 'user')
       ) fm ON fm.session_id = s.id
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

// ---- Helpers ----------------------------------------------------------------

/**
 * Prune tool result content from pre-compaction messages by replacing
 * their content with `[pruned]`. Called after a compactionSummary is stored.
 */
function pruneToolResultsBeforeSeq(sessionId: string, compactionSeq: number): void {
  const db = getDb();

  const preCompactionResults = db
    .query<{ id: number; message_json: string }, [string, number]>(
      `SELECT id, message_json FROM session_messages
       WHERE session_id = ? AND seq < ? AND role = 'toolResult'`,
    )
    .all(sessionId, compactionSeq);

  const update = db.query(
    `UPDATE session_messages SET message_json = ? WHERE id = ?`,
  );
  for (const row of preCompactionResults) {
    const msg = JSON.parse(row.message_json);
    msg.content = [{ type: "text", text: "[pruned]" }];
    update.run(JSON.stringify(msg), row.id);
  }
}

// ---- Message persistence ---------------------------------------------------

/**
 * Persist messages to SQLite. Receives the full in-memory message array from
 * the pi runtime, determines which messages are new, and delegates to
 * `appendMessages` for the actual insert + pruning.
 *
 * Three cases:
 * 1. No compaction: skip already-stored messages, append the rest.
 * 2. New compaction (first or re-): delete superseded post-compaction rows,
 *    then append compactionSummary + post-compaction messages.
 * 3. Same compaction + growth: skip already-stored post-compaction messages,
 *    append only the new tail.
 */
export function persistMessages(sessionId: string, messages: any[]): void {
  const db = getDb();

  const maxRow = db
    .query<{ max_seq: number }, [string]>(
      "SELECT COALESCE(MAX(seq), -1) AS max_seq FROM session_messages WHERE session_id = ?",
    )
    .get(sessionId)!;
  const nextSeq = maxRow.max_seq + 1;

  const compactionIdx = messages.findIndex((m: any) => m.role === "compactionSummary");

  if (compactionIdx < 0) {
    // No compaction: append messages not yet stored
    appendMessages(sessionId, messages.slice(nextSeq));
    return;
  }

  const lastSummaryRow = db
    .query<{ last_seq: number | null }, [string]>(
      `SELECT MAX(seq) AS last_seq FROM session_messages
       WHERE session_id = ? AND role = 'compactionSummary'`,
    )
    .get(sessionId);

  const postCompactionMsgCount = messages.length - (compactionIdx + 1);
  const dbPostCompactionCount = lastSummaryRow?.last_seq != null
    ? nextSeq - (lastSummaryRow.last_seq + 1)
    : 0;

  if (lastSummaryRow?.last_seq == null || postCompactionMsgCount < dbPostCompactionCount) {
    // New compaction (first or re-compaction)
    if (lastSummaryRow?.last_seq != null) {
      // Re-compaction: delete old post-compaction messages superseded by the
      // new compaction summary.
      db.query(
        `DELETE FROM session_messages
         WHERE session_id = ? AND seq > ? AND seq < ?`,
      ).run(sessionId, lastSummaryRow.last_seq, nextSeq);
    }
    appendMessages(sessionId, messages.slice(compactionIdx));
  } else {
    // Same compaction + new messages: skip already-stored messages
    const startIdx = compactionIdx + 1 + dbPostCompactionCount;
    appendMessages(sessionId, messages.slice(startIdx));
  }
}

/**
 * Load all messages for a session, ordered by seq.
 * Returns parsed message objects including compaction_summary markers.
 * Used for display (full history).
 */
export function loadMessages(sessionId: string): any[] {
  const db = getDb();
  const rows = db
    .query<{ message_json: string }, [string]>("SELECT message_json FROM session_messages WHERE session_id = ? ORDER BY seq")
    .all(sessionId);
  return rows.map((r) => JSON.parse(r.message_json));
}

/**
 * Append messages incrementally to a session. Unlike `persistMessages()` which
 * expects the full ordered message array, this inserts new messages starting
 * from the current max seq. Handles compaction boundaries the same way:
 * prunes tool result content from pre-compaction messages.
 */
export function appendMessages(sessionId: string, messages: any[]): void {
  if (messages.length === 0) return;

  const db = getDb();

  const maxRow = db
    .query<{ max_seq: number }, [string]>(
      "SELECT COALESCE(MAX(seq), -1) AS max_seq FROM session_messages WHERE session_id = ?",
    )
    .get(sessionId)!;
  let nextSeq = maxRow.max_seq + 1;

  const insert = db.query(
    `INSERT INTO session_messages (session_id, seq, role, message_json, created_at) VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
  );

  const tx = db.transaction(() => {
    for (const msg of messages) {
      insert.run(sessionId, nextSeq, msg.role, JSON.stringify(msg));

      if (msg.role === "compactionSummary") {
        pruneToolResultsBeforeSeq(sessionId, nextSeq);
      }

      nextSeq++;
    }
  });
  tx();

  // Touch updated_at
  db.query("UPDATE sessions SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(sessionId);
}

/**
 * Load messages for LLM context: returns messages from the last
 * compactionSummary (inclusive) onwards. If no compaction has occurred,
 * returns all messages.
 */
export function loadMessagesForLLM(sessionId: string): any[] {
  const db = getDb();

  // Find the seq of the last compaction summary
  const summaryRow = db
    .query<{ last_seq: number | null }, [string]>(
      `SELECT MAX(seq) AS last_seq FROM session_messages
       WHERE session_id = ? AND role = 'compactionSummary'`,
    )
    .get(sessionId);

  const minSeq = summaryRow?.last_seq != null ? summaryRow.last_seq : 0;

  const rows = db
    .query<{ message_json: string }, [string, number]>(
      `SELECT message_json FROM session_messages
       WHERE session_id = ? AND seq >= ?
       ORDER BY seq`,
    )
    .all(sessionId, minSeq);

  return rows.map((r) => JSON.parse(r.message_json));
}


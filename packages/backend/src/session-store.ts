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
  opts?: { modelProvider?: string; modelId?: string; thinkingLevel?: string; taskId?: number; parentSessionId?: string },
): SessionRow {
  const db = getDb();
  return db
    .query(
      `INSERT INTO sessions (id, project_id, model_provider, model_id, thinking_level, task_id, parent_session_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       RETURNING *`,
    )
    .get(
      id,
      projectId,
      opts?.modelProvider ?? null,
      opts?.modelId ?? null,
      opts?.thinkingLevel ?? "off",
      opts?.taskId ?? null,
      opts?.parentSessionId ?? null,
    ) as SessionRow;
}

export function getSession(id: string): SessionRow | null {
  const db = getDb();
  return (db.query("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow) ?? null;
}

export function listSessions(projectId: number): SessionListItem[] {
  const db = getDb();
  return db
    .query(
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
    .all(projectId) as SessionListItem[];
}

export function listTaskSessions(taskId: number): SessionListItem[] {
  const db = getDb();
  return db
    .query(
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
    .all(taskId) as SessionListItem[];
}

export function updateSessionMeta(
  id: string,
  updates: {
    name?: string;
    modelProvider?: string;
    modelId?: string;
    thinkingLevel?: string;
  },
): void {
  const db = getDb();
  const session = getSession(id);
  if (!session) return;

  db.query(
    `UPDATE sessions
     SET name = ?, model_provider = ?, model_id = ?, thinking_level = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ?`,
  ).run(
    updates.name ?? session.name,
    updates.modelProvider ?? session.model_provider,
    updates.modelId ?? session.model_id,
    updates.thinkingLevel ?? session.thinking_level,
    id,
  );
}

// ---- Message persistence ---------------------------------------------------

/**
 * Persist messages to SQLite. Only inserts messages with seq > current max.
 * Call this after turn_end / agent_end events with the full session.messages array.
 */
export function persistMessages(sessionId: string, messages: any[]): void {
  const db = getDb();

  const maxRow = db
    .query("SELECT COALESCE(MAX(seq), -1) AS max_seq FROM session_messages WHERE session_id = ?")
    .get(sessionId) as { max_seq: number };
  const startSeq = maxRow.max_seq + 1;

  if (startSeq >= messages.length) return; // nothing new

  const insert = db.query(
    `INSERT INTO session_messages (session_id, seq, role, message_json, created_at) VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
  );

  const tx = db.transaction(() => {
    for (let i = startSeq; i < messages.length; i++) {
      const msg = messages[i];
      insert.run(sessionId, i, msg.role, JSON.stringify(msg));
    }
  });
  tx();

  // Touch updated_at
  db.query("UPDATE sessions SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(sessionId);
}

/**
 * Apply compaction: preserve all existing messages, insert a compaction
 * summary marker, then append the post-compaction messages. Also prunes
 * tool result content from messages before the compaction boundary.
 */
export function applyCompaction(sessionId: string, messages: any[]): void {
  const db = getDb();

  const tx = db.transaction(() => {
    // Find current max seq
    const maxRow = db
      .query("SELECT COALESCE(MAX(seq), -1) AS max_seq FROM session_messages WHERE session_id = ?")
      .get(sessionId) as { max_seq: number };
    const summarySeq = maxRow.max_seq + 1;

    const insert = db.query(
      `INSERT INTO session_messages (session_id, seq, role, message_json, created_at) VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    );

    // Insert compaction summary marker
    const summaryMessage = {
      role: "compaction_summary",
      content: "Conversation summarized",
      timestamp: Date.now(),
    };
    insert.run(sessionId, summarySeq, "compaction_summary", JSON.stringify(summaryMessage));

    // Insert post-compaction messages
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      insert.run(sessionId, summarySeq + 1 + i, msg.role, JSON.stringify(msg));
    }

    // Prune tool result content from messages before the compaction boundary
    const preCompactionResults = db
      .query(
        `SELECT id, message_json FROM session_messages
         WHERE session_id = ? AND seq < ? AND role = 'toolResult'`,
      )
      .all(sessionId, summarySeq) as { id: number; message_json: string }[];

    const update = db.query(
      `UPDATE session_messages SET message_json = ? WHERE id = ?`,
    );
    for (const row of preCompactionResults) {
      const msg = JSON.parse(row.message_json);
      msg.content = [{ type: "text", text: "[pruned]" }];
      update.run(JSON.stringify(msg), row.id);
    }
  });
  tx();

  db.query("UPDATE sessions SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(sessionId);
}

/**
 * Load all messages for a session, ordered by seq.
 * Returns parsed message objects including compaction_summary markers.
 * Used for display (full history).
 */
export function loadMessages(sessionId: string): any[] {
  const db = getDb();
  const rows = db
    .query("SELECT message_json FROM session_messages WHERE session_id = ? ORDER BY seq")
    .all(sessionId) as { message_json: string }[];
  return rows.map((r) => JSON.parse(r.message_json));
}

/**
 * Load messages for LLM context: only messages after the last compaction
 * summary. If no compaction has occurred, returns all messages.
 * Excludes compaction_summary markers.
 */
export function loadMessagesForLLM(sessionId: string): any[] {
  const db = getDb();

  // Find the seq of the last compaction summary
  const summaryRow = db
    .query(
      `SELECT MAX(seq) AS last_seq FROM session_messages
       WHERE session_id = ? AND role = 'compaction_summary'`,
    )
    .get(sessionId) as { last_seq: number | null };

  const minSeq = summaryRow?.last_seq != null ? summaryRow.last_seq + 1 : 0;

  const rows = db
    .query(
      `SELECT message_json FROM session_messages
       WHERE session_id = ? AND seq >= ? AND role != 'compaction_summary'
       ORDER BY seq`,
    )
    .all(sessionId, minSeq) as { message_json: string }[];

  return rows.map((r) => JSON.parse(r.message_json));
}


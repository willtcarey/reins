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
}

export interface SessionListItem {
  id: string;
  name: string | null;
  created_at: string;
  updated_at: string;
  message_count: number;
  first_message: string | null;
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
  opts?: { modelProvider?: string; modelId?: string; thinkingLevel?: string; taskId?: number },
): SessionRow {
  const db = getDb();
  return db
    .query(
      `INSERT INTO sessions (id, project_id, model_provider, model_id, thinking_level, task_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       RETURNING *`,
    )
    .get(
      id,
      projectId,
      opts?.modelProvider ?? null,
      opts?.modelId ?? null,
      opts?.thinkingLevel ?? "off",
      opts?.taskId ?? null,
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
         fm.first_message
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
         fm.first_message
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
 * Replace all stored messages after a compaction event.
 * Deletes existing messages and writes the compacted set from scratch.
 */
export function replaceAllMessages(sessionId: string, messages: any[]): void {
  const db = getDb();

  const tx = db.transaction(() => {
    db.query("DELETE FROM session_messages WHERE session_id = ?").run(sessionId);

    const insert = db.query(
      `INSERT INTO session_messages (session_id, seq, role, message_json, created_at) VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    );
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      insert.run(sessionId, i, msg.role, JSON.stringify(msg));
    }
  });
  tx();

  db.query("UPDATE sessions SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(sessionId);
}

/**
 * Load all messages for a session, ordered by seq.
 * Returns parsed AgentMessage objects ready for `replaceMessages()`.
 */
export function loadMessages(sessionId: string): any[] {
  const db = getDb();
  const rows = db
    .query("SELECT message_json FROM session_messages WHERE session_id = ? ORDER BY seq")
    .all(sessionId) as { message_json: string }[];
  return rows.map((r) => JSON.parse(r.message_json));
}


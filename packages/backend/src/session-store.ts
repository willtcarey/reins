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

export interface SessionWindowOptions {
  since?: string;
  afterSeq?: number;
  beforeSeq?: number;
  limit?: number;
  search?: string;
  order?: "asc" | "desc";
}

export type SessionEntryType = "user" | "assistant" | "toolResult" | "compactionSummary" | "toolCall";

export interface SessionEntryOptions extends SessionWindowOptions {
  types?: SessionEntryType[];
  toolName?: string;
  isError?: boolean;
  includeContent?: boolean;
}

export interface SessionMessageEntry {
  sessionId: string;
  seq: number;
  created_at: string;
  type: Exclude<SessionEntryType, "toolCall" | "toolResult">;
  role: string;
  content?: unknown;
  [key: string]: unknown;
}

export interface SessionToolResultEntry {
  sessionId: string;
  seq: number;
  created_at: string;
  type: "toolResult";
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  isError: boolean;
  contentPreview: string;
  content?: unknown;
}

interface ToolCallBlock {
  type: "toolCall";
  id: string;
  name: string;
  arguments: unknown;
}

type PersistedContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | ToolCallBlock;

type PersistedMessageBase = {
  summary?: string;
  [key: string]: unknown;
};

type PersistedAssistantMessage = PersistedMessageBase & {
  role: "assistant";
  content: PersistedContentBlock[];
};

type PersistedMessage =
  | (PersistedMessageBase & { role: "user"; content: string | PersistedContentBlock[] })
  | PersistedAssistantMessage
  | (PersistedMessageBase & { role: "toolResult"; content: string | PersistedContentBlock[]; toolCallId: string; toolName?: string; isError: boolean })
  | (PersistedMessageBase & { role: "compactionSummary"; content?: string | PersistedContentBlock[] });

export interface SessionToolCallEntry {
  sessionId: string;
  seq: number;
  created_at: string;
  type: "toolCall";
  id: string;
  name: string;
  arguments: unknown;
}

export type SessionEntry = SessionMessageEntry | SessionToolCallEntry | SessionToolResultEntry;

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

const MESSAGE_COUNT_BY_SESSION_SQL =
  "SELECT session_id, COUNT(*) AS cnt FROM session_messages GROUP BY session_id";

const FIRST_USER_MESSAGE_BY_SESSION_SQL = `SELECT session_id,
  json_extract(message_json, '$.content[0].text') AS first_message
FROM session_messages
WHERE role = 'user'
  AND seq = (SELECT MIN(seq) FROM session_messages sm2 WHERE sm2.session_id = session_messages.session_id AND sm2.role = 'user')`;

const TOOL_RESULT_PREVIEW_CHARS = 500;
const ALL_SESSION_ENTRY_TYPES: SessionEntryType[] = ["user", "assistant", "toolResult", "compactionSummary", "toolCall"];

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

// ---- Helpers ----------------------------------------------------------------

function usesLatestWindow(options: SessionWindowOptions): boolean {
  return options.limit !== undefined && options.order === undefined && options.afterSeq === undefined && !options.since;
}

function contentToText(content: string | PersistedContentBlock[]): string {
  if (typeof content === "string") return content;

  return content.map((block) => {
    if (block.type === "text") return block.text;
    if (block.type === "thinking") return block.thinking;
    return JSON.stringify(block) ?? "";
  }).join("\n");
}

function contentPreview(content: string | PersistedContentBlock[]): string {
  const text = contentToText(content);
  if (text.length <= TOOL_RESULT_PREVIEW_CHARS) return text;
  return `${text.slice(0, TOOL_RESULT_PREVIEW_CHARS)}…`;
}

function extractToolCallBlocks(message: PersistedAssistantMessage): ToolCallBlock[] {
  return message.content.filter((block): block is ToolCallBlock => block.type === "toolCall");
}

function searchLikePattern(search: string): string {
  return `%${search.replace(/([\\%_])/g, "\\$1")}%`;
}

function orderAndLimit<T extends { seq: number }>(items: T[], options: SessionWindowOptions): T[] {
  const descending = options.order === "desc";
  const ordered = descending ? items.toReversed() : [...items];
  if (options.limit === undefined) return ordered;

  if (descending) return ordered.slice(0, options.limit);
  return usesLatestWindow(options) ? ordered.slice(-options.limit) : ordered.slice(0, options.limit);
}

function entryMatchesToolFilters(entry: SessionEntry, options: SessionEntryOptions): boolean {
  if (options.toolName) {
    if (entry.type === "toolCall") {
      if (entry.name !== options.toolName) return false;
    } else if (entry.type === "toolResult") {
      if (entry.toolName !== options.toolName) return false;
    } else {
      return false;
    }
  }

  if (options.isError !== undefined && (entry.type !== "toolResult" || entry.isError !== options.isError)) return false;
  return true;
}

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
 * List persisted session timeline entries with cursor/search filters. The result
 * can mix stored message rows (user/assistant/toolResult/compactionSummary) and
 * derived toolCall entries extracted from assistant messages.
 */
export function listSessionEntries(
  sessionId: string,
  options: SessionEntryOptions = {},
): SessionEntry[] {
  const db = getDb();
  const where: string[] = ["session_id = ?"];
  const binds: (string | number)[] = [sessionId];
  const requestedTypes = new Set<SessionEntryType>(options.types ?? ALL_SESSION_ENTRY_TYPES);

  if (requestedTypes.size === 0) return [];

  if (options.since) {
    where.push("created_at >= ?");
    binds.push(options.since);
  }

  if (options.afterSeq !== undefined) {
    where.push("seq > ?");
    binds.push(options.afterSeq);
  }

  if (options.beforeSeq !== undefined) {
    where.push("seq < ?");
    binds.push(options.beforeSeq);
  }

  const search = options.search?.trim();
  if (search) {
    where.push("message_json LIKE ? ESCAPE '\\'");
    binds.push(searchLikePattern(search));
  }

  const rows = db
    .query<{ seq: number; message_json: string; created_at: string }, (string | number)[]>(
      `SELECT seq, message_json, created_at
       FROM session_messages
       WHERE ${where.join(" AND ")}
       ORDER BY seq ASC`,
    )
    .all(...binds);

  const toolNamesById = new Map<string, string>();
  const entries: SessionEntry[] = [];

  for (const row of rows) {
    const parsed: PersistedMessage = JSON.parse(row.message_json);
    const entryType = parsed.role;

    if (requestedTypes.has(entryType)) {
      if (entryType === "toolResult") {
        const result: SessionToolResultEntry = {
          sessionId,
          seq: row.seq,
          created_at: row.created_at,
          type: "toolResult",
          role: "toolResult",
          toolCallId: parsed.toolCallId,
          toolName: parsed.toolName ?? toolNamesById.get(parsed.toolCallId) ?? "",
          isError: parsed.isError,
          contentPreview: contentPreview(parsed.content),
        };
        if (options.includeContent) result.content = parsed.content;
        entries.push(result);
      } else {
        entries.push({
          ...parsed,
          sessionId,
          seq: row.seq,
          created_at: row.created_at,
          type: entryType,
          role: entryType,
        });
      }
    }

    if (parsed.role !== "assistant") continue;

    for (const block of extractToolCallBlocks(parsed)) {
      toolNamesById.set(block.id, block.name);
      if (requestedTypes.has("toolCall")) {
        entries.push({
          sessionId,
          seq: row.seq,
          created_at: row.created_at,
          ...block,
        });
      }
    }
  }

  const filtered = entries.filter((entry) => entryMatchesToolFilters(entry, options));

  return orderAndLimit(filtered, options);
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


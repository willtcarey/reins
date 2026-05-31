/**
 * Messages Store
 *
 * SQLite-backed persistence and query helpers for session messages.
 * Owns the `session_messages` table: incremental persistence, compaction
 * pruning, LLM replay windows, and analysis-friendly timeline entries.
 */

import { getDb } from "./db.js";
import {
  collectAttachmentIds,
  externalizeImages,
  hydrateAttachmentRefs,
  pruneUnreferencedAttachmentData,
} from "./session-attachments-store.js";

// ---- Types -----------------------------------------------------------------

export interface SessionWindowOptions {
  since?: string;
  afterSeq?: number;
  beforeSeq?: number;
  limit?: number;
  search?: string;
  order?: "asc" | "desc";
}

export type SessionEntryType = "user" | "assistant" | "compactionSummary" | "toolCall";

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
  type: Exclude<SessionEntryType, "toolCall">;
  role: string;
  content?: unknown;
  [key: string]: unknown;
}

export interface SessionToolCallResult {
  seq: number;
  created_at: string;
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
  | { type: "image"; attachmentId: string; mimeType: string; filename?: string; byteSize: number; sha256?: string }
  | { type: "image"; data: string; mimeType: string; filename?: string }
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
  result: SessionToolCallResult | null;
}

export type SessionEntry = SessionMessageEntry | SessionToolCallEntry;

export interface SessionMessageRow {
  id: number;
  session_id: string;
  seq: number;
  role: string;
  message_json: string;
  created_at: string;
}

const TOOL_RESULT_PREVIEW_CHARS = 500;
const ALL_SESSION_ENTRY_TYPES: SessionEntryType[] = ["user", "assistant", "compactionSummary", "toolCall"];

// ---- Helpers ----------------------------------------------------------------

function usesLatestWindow(options: SessionWindowOptions): boolean {
  return options.limit !== undefined && options.order === undefined && options.afterSeq === undefined && !options.since;
}

function contentToText(content: string | PersistedContentBlock[]): string {
  if (typeof content === "string") return content;

  return content.map((block) => {
    if (block.type === "text") return block.text;
    if (block.type === "thinking") return block.thinking;
    if (block.type === "image") return "[image]";
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

function orderAndLimit<T extends { seq: number }>(items: T[], options: SessionWindowOptions): T[] {
  const descending = options.order === "desc";
  const ordered = descending ? items.toReversed() : [...items];
  if (options.limit === undefined) return ordered;

  if (descending) return ordered.slice(0, options.limit);
  return usesLatestWindow(options) ? ordered.slice(-options.limit) : ordered.slice(0, options.limit);
}

function entryMatchesToolFilters(entry: SessionEntry, options: SessionEntryOptions): boolean {
  if (options.toolName) {
    if (entry.type !== "toolCall" || entry.name !== options.toolName) return false;
  }

  if (options.isError !== undefined && (entry.type !== "toolCall" || entry.result?.isError !== options.isError)) return false;
  return true;
}

function rawMessageMatchesSearch(rawMessage: string, search: string | undefined): boolean {
  if (!search) return true;
  return rawMessage.toLowerCase().includes(search.toLowerCase());
}

function parsePersistedMessage(messageJson: string): PersistedMessage {
  const parsed: PersistedMessage = JSON.parse(messageJson);
  return parsed;
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

  const prunedAttachmentIds: string[] = [];
  const update = db.query(
    `UPDATE session_messages SET message_json = ? WHERE id = ?`,
  );
  for (const row of preCompactionResults) {
    const msg = JSON.parse(row.message_json);
    prunedAttachmentIds.push(...collectAttachmentIds(msg));
    msg.content = [{ type: "text", text: "[pruned]" }];
    update.run(JSON.stringify(msg), row.id);
  }

  pruneUnreferencedAttachmentData(sessionId, prunedAttachmentIds);
}

// ---- Message persistence ---------------------------------------------------

/**
 * Persist messages to SQLite. Receives the full in-memory message array from
 * the runtime, determines which messages are new, and delegates to
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
      // new compaction summary. Collect attachment refs first so orphaned BLOBs
      // can be pruned after the rows disappear.
      const deletedRows = db
        .query<{ message_json: string }, [string, number, number]>(
          `SELECT message_json FROM session_messages
           WHERE session_id = ? AND seq > ? AND seq < ?`,
        )
        .all(sessionId, lastSummaryRow.last_seq, nextSeq);
      const deletedAttachmentIds = deletedRows.flatMap((row) => {
        try {
          return collectAttachmentIds(JSON.parse(row.message_json));
        } catch {
          return [];
        }
      });

      db.query(
        `DELETE FROM session_messages
         WHERE session_id = ? AND seq > ? AND seq < ?`,
      ).run(sessionId, lastSummaryRow.last_seq, nextSeq);
      pruneUnreferencedAttachmentData(sessionId, deletedAttachmentIds);
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
    .query<{ id: number; message_json: string }, [string]>("SELECT id, message_json FROM session_messages WHERE session_id = ? ORDER BY seq")
    .all(sessionId);
  const update = db.query("UPDATE session_messages SET message_json = ? WHERE id = ?");

  return rows.map((row) => {
    const parsed = JSON.parse(row.message_json);
    const externalized = externalizeImages(sessionId, parsed);
    const nextJson = JSON.stringify(externalized);
    if (nextJson !== row.message_json) update.run(nextJson, row.id);
    return externalized;
  });
}

/**
 * List persisted session timeline entries with cursor/search filters. The result
 * can mix stored message rows (user/assistant/compactionSummary) and derived
 * toolCall entries extracted from assistant messages. Tool results are joined
 * onto their corresponding toolCall entry instead of returned separately.
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
  const rows = db
    .query<{ seq: number; message_json: string; created_at: string }, (string | number)[]>(
      `SELECT seq, message_json, created_at
       FROM session_messages
       WHERE ${where.join(" AND ")}
       ORDER BY seq ASC`,
    )
    .all(...binds)
    .map((row) => ({
      ...row,
      parsed: parsePersistedMessage(row.message_json),
      matchesSearch: rawMessageMatchesSearch(row.message_json, search),
    }));

  const toolResultsById = new Map<string, { result: SessionToolCallResult; matchesSearch: boolean }>();
  for (const row of rows) {
    if (row.parsed.role !== "toolResult") continue;

    const result: SessionToolCallResult = {
      seq: row.seq,
      created_at: row.created_at,
      isError: row.parsed.isError,
      contentPreview: contentPreview(row.parsed.content),
    };
    if (options.includeContent) result.content = row.parsed.content;

    toolResultsById.set(row.parsed.toolCallId, { result, matchesSearch: row.matchesSearch });
  }

  const entries: SessionEntry[] = [];

  for (const row of rows) {
    const parsed = row.parsed;
    const entryType = parsed.role;

    if (entryType !== "toolResult" && requestedTypes.has(entryType) && row.matchesSearch) {
      entries.push({
        ...parsed,
        sessionId,
        seq: row.seq,
        created_at: row.created_at,
        type: entryType,
        role: entryType,
      });
    }

    if (parsed.role !== "assistant") continue;

    for (const block of extractToolCallBlocks(parsed)) {
      const result = toolResultsById.get(block.id);
      if (requestedTypes.has("toolCall") && (row.matchesSearch || result?.matchesSearch)) {
        entries.push({
          sessionId,
          seq: row.seq,
          created_at: row.created_at,
          ...block,
          result: result?.result ?? null,
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
      const persisted = externalizeImages(sessionId, msg);
      insert.run(sessionId, nextSeq, persisted.role, JSON.stringify(persisted));

      if (persisted.role === "compactionSummary") {
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

  return rows.map((r) => hydrateAttachmentRefs(sessionId, JSON.parse(r.message_json)));
}

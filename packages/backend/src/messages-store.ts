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
  externalizeRuntimeContentBlock,
  hydrateImageAttachmentBlock,
  pruneUnreferencedAttachmentData,
} from "./session-attachments-store.js";

// ---- Types -----------------------------------------------------------------

export interface TextContentBlock {
  type: "text";
  text: string;
}

interface ThinkingContentBlock {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
}

interface ToolCallContentBlock {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ImageAttachmentBlock {
  type: "image";
  attachmentId: string;
  mimeType: string;
  filename?: string;
  byteSize: number;
  sha256?: string;
  width?: number;
  height?: number;
}

export interface InlineImageBlock {
  type: "image";
  data: string;
  mimeType: string;
  filename?: string;
  width?: number;
  height?: number;
}

type ClientPromptBlock = TextContentBlock | ImageAttachmentBlock;
export type ClientPromptContent = ClientPromptBlock[];

export type HydratedPromptBlock = TextContentBlock | InlineImageBlock;
export type HydratedPromptContent = HydratedPromptBlock[];

export type PersistedContentBlock = TextContentBlock | ThinkingContentBlock | ToolCallContentBlock | ImageAttachmentBlock;
export type RuntimeContentBlock = TextContentBlock | ThinkingContentBlock | ToolCallContentBlock | InlineImageBlock;

export interface RuntimeMessage {
  role: string;
  content?: RuntimeContentBlock[];
  stopReason?: string;
  summary?: string;
  [key: string]: unknown;
}

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

export interface SessionToolCallResult {
  seq: number;
  created_at: string;
  isError: boolean;
  contentPreview: string;
  content?: PersistedContentBlock[];
}

type SessionMessageEntryMetadata<Role extends Exclude<SessionEntryType, "toolCall">> = {
  sessionId: string;
  seq: number;
  created_at: string;
  type: Role;
  role: Role;
};

type PersistedMessageBase = {
  summary?: string;
  [key: string]: unknown;
};

type PersistedUserMessage = PersistedMessageBase & {
  role: "user";
  content: PersistedContentBlock[];
};

type PersistedAssistantMessage = PersistedMessageBase & {
  role: "assistant";
  content: PersistedContentBlock[];
};

type PersistedToolResultMessage = PersistedMessageBase & {
  role: "toolResult";
  content: PersistedContentBlock[];
  toolCallId: string;
  toolName?: string;
  isError: boolean;
};

type PersistedCompactionSummaryMessage = PersistedMessageBase & {
  role: "compactionSummary";
  content?: never;
};

export type PersistedMessage =
  | PersistedUserMessage
  | PersistedAssistantMessage
  | PersistedToolResultMessage
  | PersistedCompactionSummaryMessage;

export type SessionMessageEntry =
  | (PersistedUserMessage & SessionMessageEntryMetadata<"user">)
  | (PersistedAssistantMessage & SessionMessageEntryMetadata<"assistant">)
  | (PersistedCompactionSummaryMessage & SessionMessageEntryMetadata<"compactionSummary">);

export interface SessionToolCallEntry {
  sessionId: string;
  seq: number;
  created_at: string;
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result: SessionToolCallResult | null;
}

export type SessionEntry = SessionMessageEntry | SessionToolCallEntry;

export interface SessionMessageRow {
  id: number;
  parent_id: number | null;
  session_id: string;
  seq: number;
  role: string;
  message_json: string;
  created_at: string;
}

export interface SessionMessagePageItem {
  id: string;
  parentId: string | null;
  message: PersistedMessage;
}

export interface SessionMessagePage {
  items: SessionMessagePageItem[];
  pageInfo: {
    hasPreviousPage: boolean;
    previousCursor: string | null;
    hasNextPage: boolean;
    endCursor: string | null;
  };
}

const TOOL_RESULT_PREVIEW_CHARS = 500;
const ALL_SESSION_ENTRY_TYPES: SessionEntryType[] = ["user", "assistant", "compactionSummary", "toolCall"];

// ---- Helpers ----------------------------------------------------------------

function usesLatestWindow(options: SessionWindowOptions): boolean {
  return options.limit !== undefined && options.order === undefined && options.afterSeq === undefined && !options.since;
}

function contentToText(content: PersistedContentBlock[]): string {
  return content.map((block) => {
    if (block.type === "text") return block.text;
    if (block.type === "thinking") return block.thinking;
    if (block.type === "image") return "[image]";
    return JSON.stringify(block) ?? "";
  }).join("\n");
}

function contentPreview(content: PersistedContentBlock[]): string {
  const text = contentToText(content);
  if (text.length <= TOOL_RESULT_PREVIEW_CHARS) return text;
  return `${text.slice(0, TOOL_RESULT_PREVIEW_CHARS)}…`;
}

type HydratedPersistedMessage = Omit<PersistedMessage, "content"> & {
  content?: RuntimeContentBlock[];
};

function hydratePersistedMessageImages(sessionId: string, message: PersistedMessage): HydratedPersistedMessage {
  if (message.role === "compactionSummary") return message;
  return {
    ...message,
    content: message.content.map((block) => (
      block.type === "image"
        ? hydrateImageAttachmentBlock(sessionId, block)
        : block
    )),
  };
}

function extractToolCallBlocks(message: PersistedAssistantMessage): ToolCallContentBlock[] {
  return message.content.filter((block): block is ToolCallContentBlock => block.type === "toolCall");
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

function compactionSummaryMatches(summaryJson: string, incoming: RuntimeMessage): boolean {
  const parsed = parsePersistedMessage(summaryJson);
  return parsed.role === "compactionSummary"
    && incoming.role === "compactionSummary"
    && parsed.summary === incoming.summary;
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
 * 2. New compaction (first or re-): append compactionSummary + post-compaction
 *    messages while preserving the existing stored transcript.
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

  const compactionIdx = messages.findIndex((m) => m.role === "compactionSummary");

  if (compactionIdx < 0) {
    // No compaction: append messages not yet stored
    appendMessages(sessionId, messages.slice(nextSeq));
    return;
  }

  const lastSummaryRow = db
    .query<{ last_seq: number; message_json: string }, [string]>(
      `SELECT seq AS last_seq, message_json FROM session_messages
       WHERE session_id = ? AND role = 'compactionSummary'
       ORDER BY seq DESC
       LIMIT 1`,
    )
    .get(sessionId);

  let appendStartIdx = compactionIdx;
  if (lastSummaryRow) {
    const persistedTailCount = nextSeq - (lastSummaryRow.last_seq + 1);
    const incomingTailCount = messages.length - (compactionIdx + 1);
    const latestBoundaryAlreadyPersisted = compactionSummaryMatches(lastSummaryRow.message_json, messages[compactionIdx]);

    // Stored history is append-only across compactions, so DB seq is not a
    // prefix length for the runtime's current compacted snapshot. If the latest
    // summary boundary is already stored and the incoming tail still covers the
    // persisted tail, skip that prefix and append only new growth. Otherwise,
    // append the whole compacted snapshot: summary + retained tail.
    if (latestBoundaryAlreadyPersisted && incomingTailCount >= persistedTailCount) {
      appendStartIdx = compactionIdx + 1 + persistedTailCount;
    }
  }

  appendMessages(sessionId, messages.slice(appendStartIdx));
}

/** Load all messages for replay/counting callers that need the complete transcript. */
export function loadMessages(sessionId: string): any[] {
  const db = getDb();
  const rows = db
    .query<{ message_json: string }, [string]>("SELECT message_json FROM session_messages WHERE session_id = ? ORDER BY seq")
    .all(sessionId);

  return rows.map((row) => JSON.parse(row.message_json));
}

type DisplayCursorDirection = "before" | "after";

function displayCursor(sessionId: string, seq: number, direction: DisplayCursorDirection): string {
  return Buffer.from(JSON.stringify({ sessionId, seq, direction })).toString("base64url");
}

export function parseDisplayCursor(
  sessionId: string,
  cursor: string,
  direction: DisplayCursorDirection,
): number | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (!value || typeof value !== "object") return null;
    if (!("sessionId" in value) || !("seq" in value) || !("direction" in value)) return null;
    const seq = value.seq;
    if (
      value.sessionId !== sessionId
      || value.direction !== direction
      || typeof seq !== "number"
      || !Number.isSafeInteger(seq)
      || seq < 0
    ) return null;
    return seq;
  } catch {
    return null;
  }
}

interface MessagePagePosition {
  beforeSeq?: number;
  afterSeq?: number;
}

const DISPLAY_ROW_SELECT = `SELECT sm.id, sm.session_id, sm.seq, sm.role, sm.message_json, sm.created_at,
  (SELECT parent.id FROM session_messages AS parent
   WHERE parent.session_id = sm.session_id AND parent.seq < sm.seq
   ORDER BY parent.seq DESC LIMIT 1) AS parent_id
 FROM session_messages AS sm`;

function queryDisplayRows(
  sessionId: string,
  condition: string,
  values: number[],
  order: "ASC" | "DESC" = "ASC",
  limit?: number,
): SessionMessageRow[] {
  return getDb().query<SessionMessageRow, (string | number)[]>(
    `${DISPLAY_ROW_SELECT}
     WHERE sm.session_id = ? AND ${condition}
     ORDER BY sm.seq ${order}${limit === undefined ? "" : " LIMIT ?"}`,
  ).all(sessionId, ...values, ...(limit === undefined ? [] : [limit]));
}

const parseDisplayRows = (rows: SessionMessageRow[]) => rows.map((row) => ({
  row,
  message: parsePersistedMessage(row.message_json),
}));

/**
 * Load one chronological display window. The limit is soft: a selected tool
 * call row and every persisted result row it references are kept together.
 */
export function loadMessagePage(
  sessionId: string,
  limit: number,
  position: MessagePagePosition = {},
): SessionMessagePage {
  const db = getDb();
  const forward = position.afterSeq !== undefined;
  const rows = queryDisplayRows(
    sessionId,
    `sm.seq ${forward ? ">" : "<"} ?`,
    [forward ? position.afterSeq! : (position.beforeSeq ?? Number.MAX_SAFE_INTEGER)],
    forward ? "ASC" : "DESC",
    limit,
  );

  if (rows.length === 0) {
    return {
      items: [],
      pageInfo: {
        hasPreviousPage: false,
        previousCursor: null,
        hasNextPage: false,
        endCursor: position.afterSeq === undefined
          ? null
          : displayCursor(sessionId, position.afterSeq, "after"),
      },
    };
  }

  const parsedPage = parseDisplayRows(forward ? rows : rows.toReversed());
  const first = parsedPage[0];

  // A backward page can begin on a tool result. Expand its lower boundary to
  // include the assistant row that issued the call and the contiguous gap.
  if (!forward && first.message.role === "toolResult") {
    const assistant = db.query<{ seq: number }, [string, number, string]>(
      `SELECT sm.seq
       FROM session_messages AS sm
       WHERE sm.session_id = ? AND sm.seq < ? AND sm.role = 'assistant'
         AND json_valid(sm.message_json)
         AND EXISTS (
           SELECT 1 FROM json_each(sm.message_json, '$.content') AS block
           WHERE CASE WHEN block.type = 'object' THEN json_extract(block.value, '$.type') END = 'toolCall'
             AND CASE WHEN block.type = 'object' THEN json_extract(block.value, '$.id') END = ?
         )
       ORDER BY sm.seq DESC LIMIT 1`,
    ).get(sessionId, first.row.seq, first.message.toolCallId);

    if (assistant) {
      parsedPage.unshift(...parseDisplayRows(queryDisplayRows(
        sessionId,
        "sm.seq >= ? AND sm.seq < ?",
        [assistant.seq, first.row.seq],
      )));
    }
  }

  // A forward page can end on an assistant tool call. Include every result for
  // those calls (and the gap up to the final result) in the same soft-limit page.
  const last = parsedPage.at(-1)!;
  if (forward && last.message.role === "assistant") {
    const toolCallIds = last.message.content.flatMap((block) => (
      block.type === "toolCall" ? [block.id] : []
    ));
    const result = toolCallIds.length === 0 ? null : db.query<{ seq: number | null }, [string, number, string]>(
      `SELECT MAX(seq) AS seq FROM session_messages
       WHERE session_id = ? AND seq > ? AND role = 'toolResult'
         AND json_valid(message_json)
         AND json_extract(message_json, '$.toolCallId') IN (SELECT value FROM json_each(?))`,
    ).get(sessionId, last.row.seq, JSON.stringify(toolCallIds));
    if (result?.seq != null) {
      parsedPage.push(...parseDisplayRows(queryDisplayRows(
        sessionId,
        "sm.seq > ? AND sm.seq <= ?",
        [last.row.seq, result.seq],
      )));
    }
  }

  const firstSeq = parsedPage[0].row.seq;
  const lastSeq = parsedPage.at(-1)!.row.seq;
  const hasPreviousPage = db.query<{ present: number }, [string, number]>(
    `SELECT 1 AS present FROM session_messages WHERE session_id = ? AND seq < ? LIMIT 1`,
  ).get(sessionId, firstSeq) !== null;
  const hasNextPage = db.query<{ present: number }, [string, number]>(
    `SELECT 1 AS present FROM session_messages WHERE session_id = ? AND seq > ? LIMIT 1`,
  ).get(sessionId, lastSeq) !== null;

  return {
    items: parsedPage.map(({ row, message }) => ({
      id: String(row.id),
      parentId: row.parent_id === null ? null : String(row.parent_id),
      message,
    })),
    pageInfo: {
      hasPreviousPage,
      previousCursor: hasPreviousPage ? displayCursor(sessionId, firstSeq, "before") : null,
      hasNextPage,
      endCursor: displayCursor(sessionId, lastSeq, "after"),
    },
  };
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

    if (row.matchesSearch) {
      switch (parsed.role) {
        case "user":
          if (requestedTypes.has("user")) {
            entries.push({ ...parsed, sessionId, seq: row.seq, created_at: row.created_at, type: "user", role: "user" });
          }
          break;
        case "assistant":
          if (requestedTypes.has("assistant")) {
            entries.push({ ...parsed, sessionId, seq: row.seq, created_at: row.created_at, type: "assistant", role: "assistant" });
          }
          break;
        case "compactionSummary":
          if (requestedTypes.has("compactionSummary")) {
            entries.push({ ...parsed, sessionId, seq: row.seq, created_at: row.created_at, type: "compactionSummary", role: "compactionSummary" });
          }
          break;
        case "toolResult":
          break;
      }
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
export function appendMessages(sessionId: string, messages: RuntimeMessage[]): void {
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
      const persisted = msg.content
        ? { ...msg, content: msg.content.map((block) => externalizeRuntimeContentBlock(sessionId, block)) }
        : msg;
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

  return rows.map((r) => hydratePersistedMessageImages(sessionId, parsePersistedMessage(r.message_json)));
}

/**
 * Messages Store
 *
 * SQLite-backed query helpers for canonical AgentHarness session messages.
 * Owns archive/display projections and analysis-friendly timeline entries;
 * AgentHarness storage commits are the sole transcript write path.
 */

import { getDb } from "./db.js";

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
  /** Stable runtime-owned logical identity. Not a provider response or SQLite row ID. */
  logicalId?: string;
  metadata?: Record<string, unknown>;
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
  logicalId?: string;
  metadata?: Record<string, unknown>;
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

function rawMessageMatchesSearch(message: PersistedMessage, search: string | undefined): boolean {
  if (!search) return true;
  return JSON.stringify(message).toLowerCase().includes(search.toLowerCase());
}

type StoredReinsInputMessage = {
  role: "reinsInput";
  content: PersistedContentBlock[];
  timestamp?: number;
  reinsId: string;
  metadata: Record<string, unknown>;
};

type StoredEntryEnvelope =
  | { type: "message"; message: PersistedMessage | StoredReinsInputMessage; timestamp: number; terminate?: true }
  | { type: "compaction"; summary: string; retainedTail: unknown[]; tokensBefore: number; timestamp: number; fromHook: boolean; details?: unknown; usage?: unknown }
  | { type: "branch_summary" | "custom"; timestamp: number; [key: string]: unknown };

/** Project the sole canonical AgentHarness storage envelope into Reins transcript shape. */
function parsePersistedMessage(messageJson: string): PersistedMessage | null {
  const entry: StoredEntryEnvelope = JSON.parse(messageJson);
  if (entry.type === "message") {
    const message = entry.message;
    if (message.role === "reinsInput") {
      return {
        role: "user",
        content: message.content,
        timestamp: typeof message.timestamp === "number" ? message.timestamp : entry.timestamp,
      };
    }
    return message;
  }
  if (entry.type === "compaction") {
    return { role: "compactionSummary", summary: entry.summary, timestamp: entry.timestamp };
  }
  return null;
}

// ---- Message projections --------------------------------------------------

/** Load every canonical transcript entry for archive display. */
export function loadMessages(sessionId: string): any[] {
  const rows = getDb()
    .query<{ message_json: string }, [string]>("SELECT message_json FROM session_messages WHERE session_id = ? ORDER BY seq")
    .all(sessionId);

  return rows.flatMap((row) => {
    const message = parsePersistedMessage(row.message_json);
    return message ? [message] : [];
  });
}

/** Load only the canonical main-tip ancestry, excluding archived branches. */
export function loadActiveMessages(sessionId: string): any[] {
  const tipRow = getDb().query<{ value_json: string }, [string]>(
    "SELECT value_json FROM pi_values WHERE session_id = ? AND namespace = 'pi.branch.tip' AND key = 'main'",
  ).get(sessionId);
  if (!tipRow) throw new Error(`Canonical main branch is missing for session ${sessionId}`);
  const tip: unknown = JSON.parse(tipRow.value_json);
  if (tip === null) return [];
  if (typeof tip !== "string" || tip.length === 0) throw new Error(`Canonical main branch tip is invalid for session ${sessionId}`);

  const rows = getDb().query<{ message_json: string }, [string, string, string]>(
    `WITH RECURSIVE ancestry(id, parent_id, depth, visited) AS (
       SELECT id, parent_id, 0, printf('/%d/', id)
       FROM session_messages WHERE session_id = ? AND harness_id = ?
       UNION ALL
       SELECT parent.id, parent.parent_id, ancestry.depth + 1, ancestry.visited || parent.id || '/'
       FROM session_messages parent JOIN ancestry ON parent.id = ancestry.parent_id
       WHERE parent.session_id = ? AND instr(ancestry.visited, printf('/%d/', parent.id)) = 0
     )
     SELECT message_json FROM ancestry
     JOIN session_messages entry ON entry.id = ancestry.id
     ORDER BY ancestry.depth DESC`,
  ).all(sessionId, tip, sessionId);
  if (rows.length === 0) throw new Error(`Canonical main branch tip is unknown for session ${sessionId}`);
  return rows.flatMap((row) => {
    const message = parsePersistedMessage(row.message_json);
    return message ? [message] : [];
  });
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

const DISPLAY_ROW_SELECT = `SELECT sm.id, sm.parent_id, sm.session_id, sm.seq, sm.role, sm.message_json, sm.created_at
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
     WHERE sm.session_id = ?
       AND json_extract(sm.message_json, '$.type') IN ('message', 'compaction')
       AND ${condition}
     ORDER BY sm.seq ${order}${limit === undefined ? "" : " LIMIT ?"}`,
  ).all(sessionId, ...values, ...(limit === undefined ? [] : [limit]));
}

const parseDisplayRows = (rows: SessionMessageRow[]) => rows.flatMap((row) => {
  const message = parsePersistedMessage(row.message_json);
  return message ? [{ row, message }] : [];
});

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
    const boundary = forward ? position.afterSeq! : (position.beforeSeq ?? Number.MAX_SAFE_INTEGER);
    const hasPreviousPage = db.query<{ present: number }, [string, number]>(
      `SELECT 1 AS present FROM session_messages
       WHERE session_id = ? AND json_extract(message_json, '$.type') IN ('message', 'compaction')
         AND seq ${forward ? "<=" : "<"} ? LIMIT 1`,
    ).get(sessionId, boundary) !== null;
    const hasNextPage = db.query<{ present: number }, [string, number]>(
      `SELECT 1 AS present FROM session_messages
       WHERE session_id = ? AND json_extract(message_json, '$.type') IN ('message', 'compaction')
         AND seq ${forward ? ">" : ">="} ? LIMIT 1`,
    ).get(sessionId, boundary) !== null;
    return {
      items: [],
      pageInfo: {
        hasPreviousPage,
        previousCursor: hasPreviousPage ? displayCursor(sessionId, boundary, "before") : null,
        hasNextPage,
        endCursor: forward ? displayCursor(sessionId, boundary, "after") : null,
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
           SELECT 1 FROM json_each(sm.message_json, '$.message.content') AS block
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
         AND json_extract(message_json, '$.message.toolCallId') IN (SELECT value FROM json_each(?))`,
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
    `SELECT 1 AS present FROM session_messages
     WHERE session_id = ? AND json_extract(message_json, '$.type') IN ('message', 'compaction') AND seq < ? LIMIT 1`,
  ).get(sessionId, firstSeq) !== null;
  const hasNextPage = db.query<{ present: number }, [string, number]>(
    `SELECT 1 AS present FROM session_messages
     WHERE session_id = ? AND json_extract(message_json, '$.type') IN ('message', 'compaction') AND seq > ? LIMIT 1`,
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
  const requestedTypes = new Set<SessionEntryType>(options.types ?? ALL_SESSION_ENTRY_TYPES);
  if (requestedTypes.size === 0) return [];

  const search = options.search?.trim();
  const rows = db
    .query<{ seq: number; message_json: string; created_at: string }, [string]>(
      `SELECT seq, message_json, created_at
       FROM session_messages
       WHERE session_id = ?
       ORDER BY seq ASC`,
    )
    .all(sessionId)
    .map((row) => ({ ...row, parsed: parsePersistedMessage(row.message_json) }))
    .filter((row): row is typeof row & { parsed: PersistedMessage } => row.parsed !== null)
    .map((row) => ({
      ...row,
      inWindow: (!options.since || row.created_at >= options.since) &&
        (options.afterSeq === undefined || row.seq > options.afterSeq) &&
        (options.beforeSeq === undefined || row.seq < options.beforeSeq),
      matchesSearch: rawMessageMatchesSearch(row.parsed, search),
    }));

  const toolResultsById = new Map<string, { result: SessionToolCallResult; matchesSearch: boolean; inWindow: boolean }[]>();
  for (const row of rows) {
    if (row.parsed.role !== "toolResult") continue;

    const result: SessionToolCallResult = {
      seq: row.seq,
      created_at: row.created_at,
      isError: row.parsed.isError,
      contentPreview: contentPreview(row.parsed.content),
    };
    if (options.includeContent) result.content = row.parsed.content;

    const candidate = { result, matchesSearch: row.matchesSearch, inWindow: row.inWindow };
    const existing = toolResultsById.get(row.parsed.toolCallId);
    if (existing) existing.push(candidate);
    else toolResultsById.set(row.parsed.toolCallId, [candidate]);
  }

  const entries: SessionEntry[] = [];

  for (const row of rows) {
    const parsed = row.parsed;

    if (row.inWindow && row.matchesSearch) {
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
      const result = toolResultsById.get(block.id)?.find((candidate) => candidate.result.seq > row.seq);
      const assistantMatches = row.inWindow && row.matchesSearch;
      const resultMatches = result?.inWindow === true && result.matchesSearch;
      if (requestedTypes.has("toolCall") && (assistantMatches || resultMatches)) {
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

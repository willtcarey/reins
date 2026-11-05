/**
 * `sessions` (docs/dev/server-sdk.md *Sessions*): starting, messaging, waiting for, reading and changing sessions,
 * for an extension (`reins.sessions`) and an agent's script (`api.sessions`), over the `Sessions` model. The caller
 * decides the defaults and the origin: a script's session starts where the caller works and reports back to it as
 * its child, and its messages are session updates from it (`sourceSessionId`); an extension acts as no session,
 * so it names where a session works, and what it starts and sends records it (`sourceExtension`). Settlement
 * listeners are the host's (`ExtensionHost.sessionSettled`), for extensions only.
 */

import { Type } from "@sinclair/typebox";
import type { MessageContent, MessageMetadata, ScriptNamespace, SessionInfo, SessionStartOptions } from "@reins/sdk/server";
import { getDb } from "../app-globals.js";
import { countMessages, listSessionEntries } from "../messages-store.js";
import { ThinkingLevelSchema } from "../models/model-settings.js";
import type { SessionModel } from "../models/session.js";
import { resolveSource } from "../models/sources.js";
import { readNewestRunResult, readPendingPiOperation } from "../pi/run-state.js";
import { firstMessage, getSession, listSessions, type SessionRow } from "../session-store.js";
import { assertPlace, inheritedSource } from "../sessions/create-session.js";
import { latestSettlement } from "../sessions/session-runs.js";
import { LocationSchema } from "./nodes.js";
import { notForScripts, sdkMethod, signalOf, type CallContext } from "./declaration.js";

const MAX_LABEL = 80;
const MAX_METADATA_BYTES = 64 * 1024;
const REINS_KEYS = ["sourceExtension", "sourceSessionId", "details"];
const MAX_CHILD_DEPTH = 3;
const DEFAULT_WAIT_MS = 10_000;
const MAX_WAIT_MS = 30_000;
const MAX_LIST_LIMIT = 200;
/** An extension's list of every project is paged. */
const DEFAULT_PAGE = 50;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const CurrentSchema = Type.Literal("current");

export const SessionSourceSchema = Type.Object({
  id: Type.Number({ description: "The source's ID." }),
  nodeId: Type.String(),
  path: Type.String({ description: "An absolute path on the node." }),
}, { description: "Where a session works: its source, a node and a directory there." });

export const SessionModelSchema = Type.Object({
  provider: Type.String(),
  modelId: Type.String(),
  thinkingLevel: Type.Union([ThinkingLevelSchema, Type.Literal("off")]),
});

export const ModelChoiceSchema = Type.Object({
  provider: Type.String({ minLength: 1 }),
  modelId: Type.String({ minLength: 1 }),
  thinkingLevel: Type.Optional(ThinkingLevelSchema),
});

export const SessionSchema = Type.Object({
  id: Type.String(),
  source: SessionSourceSchema,
  projectId: Type.Union([Type.Number(), Type.Null()], { description: "Its project; null for a session of no project, which has no task." }),
  taskId: Type.Union([Type.Number(), Type.Null()]),
  parentSessionId: Type.Union([Type.String(), Type.Null()]),
  name: Type.Union([Type.String(), Type.Null()]),
  firstMessage: Type.Union([Type.String(), Type.Null()], { description: "The text of its first message; null before it has one." }),
  messageCount: Type.Number(),
  model: Type.Union([SessionModelSchema, Type.Null()], { description: "The model it runs; null before it has one." }),
  background: Type.Boolean({ description: "A background session, which Reins features start and the browser never shows. Left out of sessions.list unless options.background asks for it." }),
  running: Type.Boolean({ description: "Its run is in progress now." }),
  unread: Type.Boolean({ description: "Its last run ended with something the user has not opened. Reading it does not mark it read." }),
  pinned: Type.Boolean({ description: "Pinned above the unpinned sessions." }),
  archived: Type.Boolean({ description: "Archived: left out of the session lists." }),
  startedBy: Type.Union([Type.String(), Type.Null()], { description: "The backend extension that started it, or null." }),
  lastRunStartedAt: Type.Union([Type.String(), Type.Null()], { description: "When its latest run started; null before its first." }),
  lastRunId: Type.Union([Type.String(), Type.Null()], { description: "Its latest ended run, an opaque ID to compare; null before its first ends." }),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});

export const SessionHandleSchema = Type.Object({ sessionId: Type.String() });

export const SessionWaitResultSchema = Type.Object({
  sessionId: Type.String(),
  status: Type.Union([Type.Literal("idle"), Type.Literal("completed"), Type.Literal("failed"), Type.Literal("cancelled"), Type.Literal("timeout")]),
  result: Type.Union([Type.String(), Type.Null()]),
  error: Type.Union([Type.String(), Type.Null()]),
});

export const ContextUsageSchema = Type.Object({
  usedTokens: Type.Number({ description: "Its context's tokens: as its latest model response reported (exact), or estimated after a compaction." }),
  contextWindow: Type.Number(),
  measurement: Type.Union([Type.Literal("exact"), Type.Literal("estimated")]),
});

export const MessageBlockSchema = Type.Object({
  text: Type.String(),
  hidden: Type.Optional(Type.Boolean({ description: "Collapsed under the message in the chat; the model gets it after the visible blocks." })),
  label: Type.Optional(Type.String({ description: "The first hidden block only: the heading the chat shows above the hidden blocks." })),
});

export const MessageContentSchema = Type.Union([Type.String({ minLength: 1 }), Type.Array(Type.Union([Type.String(), MessageBlockSchema]), { minItems: 1 })], {
  description: "Its text, or blocks in order: strings, or { text, hidden?, label? } (visible blocks first).",
});

const MetadataSchema = notForScripts(Type.Record(Type.String(), Type.Unknown(), { description: "The message's metadata, kept in the transcript; the model does not get it." }));

export const MessageEntrySchema = Type.Object({
  sessionId: Type.String(),
  seq: Type.Number(),
  createdAt: Type.String(),
  type: Type.Union([Type.Literal("user"), Type.Literal("assistant"), Type.Literal("compactionSummary")]),
  role: Type.String(),
  content: Type.Optional(Type.Unknown()),
  summary: Type.Optional(Type.String()),
});

export const ToolCallResultSchema = Type.Object({
  seq: Type.Number(),
  createdAt: Type.String(),
  isError: Type.Boolean(),
  contentPreview: Type.String(),
  content: Type.Optional(Type.Unknown()),
});

export const ToolCallEntrySchema = Type.Object({
  sessionId: Type.String(),
  seq: Type.Number(),
  createdAt: Type.String(),
  type: Type.Literal("toolCall"),
  id: Type.String(),
  name: Type.String(),
  arguments: Type.Unknown(),
  result: Type.Union([ToolCallResultSchema, Type.Null()]),
});

export const SessionEntrySchema = Type.Union([MessageEntrySchema, ToolCallEntrySchema]);

const ListQuerySchema = Type.Object({
  projectId: Type.Optional(Type.Union([Type.Number(), CurrentSchema], { description: "A project's sessions; the caller's when left out or \"current\"." })),
  taskId: Type.Optional(Type.Union([Type.Number(), Type.Null(), CurrentSchema], { description: "One task's sessions (\"current\": the caller's), or null for those of no task." })),
  since: Type.Optional(Type.String({ description: "Only those changed since then (an ISO time)." })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIST_LIMIT })),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  search: Type.Optional(Type.String({ description: "Words in its ID, name, task's title or messages." })),
  minMessages: Type.Optional(Type.Number()),
  background: Type.Optional(Type.Union([Type.Literal("exclude"), Type.Literal("only"), Type.Literal("include")], {
    description: "Background sessions are left out by default; \"only\" lists just them, \"include\" both.",
  })),
});

const EntryQuerySchema = Type.Object({
  types: Type.Optional(Type.Array(Type.Union([Type.Literal("user"), Type.Literal("assistant"), Type.Literal("compactionSummary"), Type.Literal("toolCall")]))),
  toolName: Type.Optional(Type.String()),
  isError: Type.Optional(Type.Boolean()),
  since: Type.Optional(Type.String()),
  afterSeq: Type.Optional(Type.Number()),
  beforeSeq: Type.Optional(Type.Number()),
  limit: Type.Optional(Type.Number()),
  search: Type.Optional(Type.String()),
  order: Type.Optional(Type.Union([Type.Literal("asc"), Type.Literal("desc")])),
  includeContent: Type.Optional(Type.Boolean({ description: "Give tool results' whole content, not only a preview." })),
});

const StartOptionsSchema = Type.Object({
  parentSessionId: Type.Optional(Type.Union([CurrentSchema, Type.Null()], {
    description: "Required from a script: \"current\" makes a child of the caller (in any project), which reports its outcome back to it; null an independent session.",
  })),
  projectId: Type.Optional(Type.Union([Type.Number(), CurrentSchema], { description: "Its project: the caller's when left out or \"current\"." })),
  taskId: Type.Optional(Type.Union([Type.Number(), Type.Null(), CurrentSchema], {
    description: "A task of its project. In the caller's project the caller's task when left out or \"current\"; in another project none when left out; null for none.",
  })),
  source: Type.Optional(Type.Union([Type.Number({ description: "A source's ID." }), LocationSchema, Type.Null()], {
    description: "Where it works: the caller's checkout when left out (in another project: where that project's sessions work).",
  })),
  model: Type.Optional(ModelChoiceSchema),
  title: Type.Optional(Type.String({ minLength: 1, description: "Its name; left out, it is named as any session is." })),
  background: Type.Optional(notForScripts(Type.Boolean())),
  metadata: Type.Optional(MetadataSchema),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The calling session; an extension, which has none, is refused. */
function callingSession(context: CallContext, what = "\"current\""): SessionModel {
  if (context.caller.kind !== "session") throw new Error(`${what} names the calling session, and an extension has none`);
  return context.caller.session;
}

/** Where the JSON in `value` is not plain (a class instance, a function, …), or null. */
function notPlainJson(value: unknown, path: string): string | null {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return typeof value === "number" && !Number.isFinite(value) ? `a non-finite number at ${path}` : null;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) { const found = notPlainJson(item, `${path}[${index}]`); if (found) return found; }
    return null;
  }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, item] of Object.entries(value)) { const found = notPlainJson(item, path ? `${path}.${key}` : key); if (found) return found; }
    return null;
  }
  const kind = typeof value === "object" && value !== null ? value.constructor?.name ?? "object" : typeof value;
  return `a ${kind} at ${path}`;
}

function checkedMetadata(metadata: MessageMetadata | undefined): { metadata?: Record<string, unknown> } {
  if (metadata === undefined) return {};
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) throw new Error("Metadata must be a plain object");
  const notPlain = notPlainJson(metadata, "");
  if (notPlain) throw new Error(`Metadata must be plain JSON: ${notPlain}`);
  if (new TextEncoder().encode(JSON.stringify(metadata)).length > MAX_METADATA_BYTES) throw new Error(`Metadata must be at most ${MAX_METADATA_BYTES} bytes of JSON`);
  const reserved = Object.keys(metadata).find(key => REINS_KEYS.includes(key));
  if (reserved) throw new Error(`Metadata key ${reserved} is set by Reins`);
  return Object.keys(metadata).length > 0 ? { metadata: { ...metadata } } : {};
}

/** A message's blocks as a submission's content, and where its hidden ones begin (with their label). */
function checkedContent(message: MessageContent, blank: string): { content: { type: "text"; text: string }[]; details?: { start: number; label: string | null } } {
  if (typeof message === "string") {
    if (!message.trim()) throw new Error(blank);
    return { content: [{ type: "text", text: message }] };
  }
  if (!Array.isArray(message)) throw new Error(blank);
  const blocks = message.map(block => typeof block === "string" ? { text: block, hidden: false, label: undefined } : { text: block?.text, hidden: block?.hidden === true, label: block?.label });
  const start = blocks.findIndex(block => block.hidden);
  if (start >= 0 && blocks.slice(start).some(block => !block.hidden)) throw new Error("A message's hidden blocks come after its visible ones");
  if (start === 0 || blocks.length === 0) throw new Error(blank);
  if (blocks.some(block => typeof block.text !== "string" || !block.text.trim())) throw new Error("A message's blocks must not be blank");
  if (blocks.some((block, index) => block.label !== undefined && index !== start)) throw new Error("Only a message's first hidden block has a label");
  const content = blocks.map(block => ({ type: "text" as const, text: block.text }));
  if (start < 0) return { content };
  const label = blocks[start]!.label === undefined ? null : String(blocks[start]!.label).trim();
  if (label !== null && (label.length === 0 || label.length > MAX_LABEL)) throw new Error(`A hidden block's label is 1 to ${MAX_LABEL} characters`);
  return { content, details: { start, label } };
}

/** What the caller's input records as its origin: the calling session, or the extension. */
function origin(context: CallContext): { sourceSessionId: string } | { sourceExtension: string } {
  return context.caller.kind === "session" ? { sourceSessionId: context.caller.session.id } : { sourceExtension: context.caller.name };
}

/** When the session's latest run started, as Pi recorded it: the run in progress, else the newest that ended. */
function lastRunStartedAt(sessionId: string): string | null {
  const pending = readPendingPiOperation(getDb(), sessionId);
  const startedAt = pending?.kind === "run" ? pending.startedAt : readNewestRunResult(getDb(), sessionId)?.startedAt;
  return startedAt === undefined ? null : new Date(startedAt).toISOString();
}

function thinkingLevelOf(level: string): Exclude<SessionInfo["model"], null>["thinkingLevel"] {
  return ThinkingLevelSchema.anyOf.find(member => member.const === level)?.const ?? "off";
}

function sessionInfo(context: CallContext, row: SessionRow): SessionInfo {
  const source = resolveSource(row.source_id);
  const running = context.models.sessions.running(row);
  return {
    id: row.id,
    source: { id: source.id, nodeId: source.node_id, path: source.path },
    projectId: row.project_id,
    taskId: row.task_id,
    parentSessionId: row.parent_session_id,
    name: row.name,
    firstMessage: row.first_message === undefined ? firstMessage(row.id) : row.first_message,
    messageCount: row.message_count ?? countMessages(row.id),
    model: row.model_provider && row.model_id ? { provider: row.model_provider, modelId: row.model_id, thinkingLevel: thinkingLevelOf(row.thinking_level) } : null,
    background: row.background === 1,
    running,
    unread: !running && row.activity_state === "finished",
    pinned: row.pinned_at !== null,
    archived: row.archived_at !== null,
    startedBy: row.source_extension,
    lastRunStartedAt: lastRunStartedAt(row.id),
    lastRunId: latestSettlement(row.id)?.operationId ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The session's row; "Session not found: <id>" when there is none. */
function sessionRow(context: CallContext, sessionId: string): SessionRow {
  return context.models.sessions.get(sessionId).row;
}

const sessionOf = (context: CallContext, sessionId: string) => sessionInfo(context, sessionRow(context, sessionId));

function assertChildDepth(caller: SessionRow): void {
  let ancestor: SessionRow | null = caller;
  let depth = 0;
  while (ancestor?.parent_session_id) {
    if (++depth >= MAX_CHILD_DEPTH) throw new Error(`Maximum child session depth (${MAX_CHILD_DEPTH}) reached`);
    ancestor = getSession(ancestor.parent_session_id);
  }
}

/** Where and how a session the caller starts is made, from what it gives and its own defaults. */
function placement(context: CallContext, options: SessionStartOptions) {
  const { parentSessionId, projectId, taskId, source, model, title, background } = options;
  const named = { ...(title === undefined ? {} : { title }), ...(model ? { model } : {}) };
  if (context.caller.kind === "extension") {
    for (const [key, value] of Object.entries({ parentSessionId, projectId, taskId })) {
      if (value === "current") throw new Error(`options.${key} "current" names the calling session, and an extension has none`);
    }
    return {
      ...(typeof projectId === "number" ? { projectId } : {}),
      ...(typeof taskId === "number" ? { taskId } : {}),
      ...(source == null ? {} : { source }),
      ...named,
      background: background === true,
      sourceExtension: context.caller.name,
    };
  }
  if (parentSessionId === undefined) throw new Error("options.parentSessionId is required: \"current\" for a child of this session, null for an independent session");
  const caller = getSession(context.caller.session.id) ?? context.caller.session.row;
  if (parentSessionId === "current") assertChildDepth(caller);
  const project = projectId === undefined || projectId === "current" ? caller.project_id : projectId;
  const elsewhere = project !== caller.project_id;
  const task = taskId === undefined ? (elsewhere ? null : caller.task_id) : taskId === "current" ? caller.task_id : taskId;
  let place: number | { nodeId: string; path: string } = source ?? caller.source_id;
  if (elsewhere && source == null && project !== null) {
    // Checked first: inheriting a source assumes the project, and the task of it, exist.
    assertPlace(project, task ?? undefined, true);
    place = inheritedSource(project, task ?? undefined).id;
  }
  const thinkingLevel = caller.thinking_level === "off" ? undefined : caller.thinking_level;
  const inherited = caller.model_provider && caller.model_id
    ? { model: { provider: caller.model_provider, modelId: caller.model_id, ...(thinkingLevel === undefined ? {} : { thinkingLevel }) } }
    : {};
  return {
    ...(project === null ? {} : { projectId: project }),
    ...(task === null ? {} : { taskId: task }),
    source: place,
    ...(parentSessionId === "current" ? { parentSessionId: caller.id } : {}),
    ...inherited,
    ...named,
  };
}

// ---------------------------------------------------------------------------
// Methods
// ---------------------------------------------------------------------------

const sessionIdParam = { name: "sessionId", schema: Type.String({ minLength: 1 }) } as const;

const start = sdkMethod({
  description: "Start a fresh session and return its sessionId without waiting for completion. " +
    "It starts in the caller's project unless options.projectId names another, and in the caller's task unless options.taskId names another task " +
    "of that project (or null for none; in another project it has none unless taskId names one of its tasks). " +
    "Optional title names it; left out, it is named as any session is. The model defaults to the caller's. " +
    "It works in the caller's checkout (in another project: where that project's sessions work, its home source by default) " +
    "unless options.source ({ nodeId, path }) names another location (a directory not used yet is checked on its node). " +
    "Sessions share the checkout: coordinate file edits. Only start other agents when the user explicitly asks for delegation or parallel sessions. " +
    "Children report their latest outcome when their run settles, prompting idle parents or steering busy ones. Reports are not queued or retried. " +
    "Continue other work or end your turn rather than polling. Independent sessions require explicit result retrieval.",
  params: [
    { name: "prompt", schema: MessageContentSchema },
    { name: "options", schema: StartOptionsSchema, optional: true },
  ],
  returns: SessionHandleSchema,
  tags: ["sessions", "start", "create", "delegate", "async", "parent", "title", "task"],
  async run(context, prompt, options = {}) {
    const content = checkedContent(prompt, "A session's prompt must not be blank");
    const metadata = checkedMetadata(options.metadata);
    const request = placement(context, options);
    if (signalOf(context).aborted) throw new DOMException("Aborted", "AbortError");
    const sessions = context.models.sessions;
    // A refused first prompt leaves the session: it is sent to again, or moved.
    const { id } = await sessions.create(request);
    await sessions.submit(id, { op: "prompt", clientId: crypto.randomUUID(), ...content, ...metadata, ...(context.caller.kind === "extension" ? { sourceExtension: context.caller.name } : {}) });
    return { sessionId: id };
  },
});

const send = sdkMethod({
  description: "Send a message to any session, in any project or task, reopening it if necessary. " +
    "An idle session starts a run with it; a busy one takes it into its work (native steering), without cancelling or restarting. " +
    "It is accepted durably before it runs. No queued follow-ups, deferred delivery or automatic restart. Returns without waiting for a response.",
  params: [
    sessionIdParam,
    { name: "message", schema: MessageContentSchema },
    { name: "options", schema: Type.Object({ metadata: Type.Optional(MetadataSchema) }), optional: true },
  ],
  returns: Type.Void(),
  tags: ["sessions", "send", "message", "steer", "resume", "async"],
  async run(context, sessionId, message, options = {}) {
    sessionRow(context, sessionId);
    const content = checkedContent(message, "A message must not be blank");
    const metadata = checkedMetadata(options.metadata);
    if (signalOf(context).aborted) throw new DOMException("Aborted", "AbortError");
    await context.models.sessions.submit(sessionId, { op: "steer", clientId: crypto.randomUUID(), ...content, ...metadata, ...origin(context) });
  },
});

const wait = sdkMethod({
  description: "Wait until any session, in any project or task, is at rest (its native steering and compaction included), then return its latest response or outcome. " +
    "timeoutMs defaults to 10000, at most 30000; 0 checks at once. A timeout, or cancelling this script, never cancels the session. " +
    "A session already at rest returns at once, from its saved transcript. Children report to their parent by themselves, so waiting is optional. A session cannot wait for itself.",
  params: [
    sessionIdParam,
    { name: "timeoutMs", schema: Type.Integer({ minimum: 0, maximum: MAX_WAIT_MS }), optional: true },
  ],
  returns: SessionWaitResultSchema,
  tags: ["sessions", "wait", "settled", "result", "async", "timeout"],
  async run(context, sessionId, timeoutMs = DEFAULT_WAIT_MS) {
    sessionRow(context, sessionId);
    // It would always time out: the caller is running while it waits.
    if (context.caller.kind === "session" && sessionId === context.caller.session.id) throw new Error("A session cannot wait for itself");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_WAIT_MS) throw new Error(`timeoutMs must be an integer between 0 and ${MAX_WAIT_MS}`);
    const signal = signalOf(context);
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    return context.models.sessions.waitForSettlement(sessionId, timeoutMs, { signal });
  },
});

const list = sdkMethod({
  description:
    "List sessions: by default the caller's project's (from a session of no project: the sessions of no project on its source), pinned first, then the latest change. " +
    "Pass projectId for another project, taskId for one task's sessions (\"current\": the caller's), or taskId: null for those of no task. " +
    "Archived and background sessions are left out.",
  params: [{ name: "options", schema: ListQuerySchema, optional: true }],
  returns: Type.Array(SessionSchema),
  tags: ["sessions", "list", "query", "read", "scratch", "filter", "search", "messages", "unread", "activity"],
  async run(context, query = {}) {
    const { projectId, taskId, limit, offset, since, search, minMessages, background } = query;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT)) throw new Error(`limit must be an integer from 1 to ${MAX_LIST_LIMIT}`);
    if (offset !== undefined && (!Number.isInteger(offset) || offset < 0)) throw new Error("offset must be a non-negative integer");
    const filters = { since, search, minMessages, background, offset };
    const task = taskId === "current" ? callingSession(context).taskId : taskId;
    if (projectId === undefined && context.caller.kind === "extension") {
      const rows = listSessions({ projectId: "any", taskId: task, includeTaskSessions: task === undefined, ...filters, limit: limit ?? DEFAULT_PAGE, orderBy: "latest" });
      return rows.map(row => sessionInfo(context, row));
    }
    const caller = projectId === undefined || projectId === "current" ? callingSession(context) : null;
    const project = projectId === undefined || projectId === "current" ? callingSession(context).projectId : projectId;
    const rows = listSessions({
      projectId: project,
      // Without a project, the default list is the sessions of no project on the caller's source.
      ...(project === null && caller ? { sourceId: caller.row.source_id } : {}),
      taskId: task,
      includeTaskSessions: task === undefined,
      ...filters,
      limit,
    });
    return rows.map(row => sessionInfo(context, row));
  },
});

const current = sdkMethod({
  description: "Get the current session (the one running this script). No ID needed.",
  params: [],
  returns: SessionSchema,
  tags: ["sessions", "current", "read", "self", "context"],
  run: async context => sessionOf(context, callingSession(context, "sessions.current").id),
});

const get = sdkMethod({
  description: "Get a session by ID, of any project. Throws if not found.",
  params: [sessionIdParam],
  returns: SessionSchema,
  tags: ["sessions", "get", "read", "lookup"],
  run: async (context, sessionId) => sessionOf(context, sessionId),
});

const entries = sdkMethod({
  description:
    "List session timeline entries: user/assistant/compactionSummary messages and derived toolCall entries. Pass options.types to narrow the " +
    "entry types; tool calls include joined result previews when available, and raw result content only when includeContent is true.",
  params: [sessionIdParam, { name: "options", schema: EntryQuerySchema, optional: true }],
  returns: Type.Array(SessionEntrySchema),
  tags: ["sessions", "entries", "messages", "read", "history", "conversation", "filter", "search", "prompts", "tools", "tool", "calls", "results", "trace", "errors"],
  async run(context, sessionId, options) {
    sessionRow(context, sessionId);
    return listSessionEntries(sessionId, options ?? {});
  },
});

const setModel = sdkMethod({
  description:
    "Change the AI model of a session, of any project, from its next turn on. Use models.list() to find providers and model IDs. " +
    "thinkingLevel defaults to the session's own.",
  params: [
    sessionIdParam,
    { name: "provider", schema: Type.String() },
    { name: "modelId", schema: Type.String() },
    { name: "thinkingLevel", schema: ThinkingLevelSchema, optional: true },
  ],
  returns: SessionSchema,
  tags: ["sessions", "model", "set", "write", "switch", "provider"],
  async run(context, sessionId, provider, modelId, thinkingLevel) {
    sessionRow(context, sessionId);
    return sessionInfo(context, await context.models.sessions.setModel({ sessionId, provider, modelId, ...(thinkingLevel === undefined ? {} : { thinkingLevel }) }));
  },
});

const compact = sdkMethod({
  description:
    "Compact an idle session now: its context is replaced by a summary, focused on options.instructions when given. " +
    "Returns once the compaction started; it runs in the background (sessions.wait observes its end). " +
    "Throws while the session is running (a session cannot compact itself from a script) or has nothing to compact.",
  params: [sessionIdParam, { name: "options", schema: Type.Object({ instructions: Type.Optional(Type.String()) }), optional: true }],
  returns: Type.Void(),
  tags: ["sessions", "compact", "compaction", "summary", "context", "write"],
  async run(context, sessionId, options = {}) {
    sessionRow(context, sessionId);
    await context.models.sessions.compact(sessionId, options.instructions ? { instructions: options.instructions } : {});
  },
});

const contextUsage = sdkMethod({
  description: "How full a session's context is: its tokens and its model's context window; null when not known (no model yet).",
  params: [sessionIdParam],
  returns: Type.Union([ContextUsageSchema, Type.Null()]),
  tags: ["sessions", "context", "tokens", "usage", "window", "read"],
  async run(context, sessionId) {
    sessionRow(context, sessionId);
    const snapshot = await context.models.sessions.getContext(sessionId);
    return snapshot && { usedTokens: snapshot.usedTokens, contextWindow: snapshot.contextWindow, measurement: snapshot.measurement };
  },
});

/** Changes the session's name, pin or archive state; its view after. */
function updated(context: CallContext, sessionId: string, updates: Parameters<CallContext["models"]["sessions"]["updateMetadata"]>[1]): SessionInfo {
  sessionRow(context, sessionId);
  context.models.sessions.updateMetadata(sessionId, updates);
  return sessionOf(context, sessionId);
}

const setName = sdkMethod({
  description: "Rename a session, or pass null to clear its name. Names are trimmed and must not be blank.",
  params: [
    sessionIdParam,
    {
      name: "name",
      schema: Type.Union([
        Type.String({ minLength: 1, description: "Its new name. Leading and trailing whitespace is removed." }),
        Type.Null({ description: "Clear the name and restore the session's fallback label." }),
      ]),
    },
  ],
  returns: SessionSchema,
  tags: ["sessions", "session", "name", "rename", "title", "set", "write", "metadata"],
  async run(context, sessionId, name) {
    if (name !== null && (typeof name !== "string" || !name.trim())) throw new Error("Invalid session name; expected a non-empty string or null");
    return updated(context, sessionId, { name: name === null ? null : name.trim() });
  },
});

const setPinned = sdkMethod({
  description: "Pin or unpin a session. Pinning is independent of archive state and does not affect parent or child sessions.",
  params: [sessionIdParam, { name: "pinned", schema: Type.Boolean() }],
  returns: SessionSchema,
  tags: ["sessions", "session", "pin", "pinned", "unpin", "set", "write", "organize"],
  run: async (context, sessionId, pinned) => updated(context, sessionId, { pinned }),
});

const setArchived = sdkMethod({
  description: "Archive or unarchive a session. Archiving keeps its history, pin state and parent/child relations; archived sessions are left out of lists.",
  params: [sessionIdParam, { name: "archived", schema: Type.Boolean() }],
  returns: SessionSchema,
  tags: ["sessions", "session", "archive", "archived", "unarchive", "set", "write", "organize"],
  run: async (context, sessionId, archived) => updated(context, sessionId, { archived }),
});

export const SESSIONS = {
  namespace: "sessions",
  methods: { start, send, wait, list, current, get, entries, setModel, compact, contextUsage, setName, setPinned, setArchived },
  types: {
    Session: SessionSchema,
    SessionSource: SessionSourceSchema,
    SessionModel: SessionModelSchema,
    ModelChoice: ModelChoiceSchema,
    SessionHandle: SessionHandleSchema,
    SessionWaitResult: SessionWaitResultSchema,
    ContextUsage: ContextUsageSchema,
    MessageContent: MessageContentSchema,
    MessageBlock: MessageBlockSchema,
    SessionEntry: SessionEntrySchema,
    MessageEntry: MessageEntrySchema,
    ToolCallEntry: ToolCallEntrySchema,
    ToolCallResult: ToolCallResultSchema,
  },
} satisfies ScriptNamespace<CallContext>;

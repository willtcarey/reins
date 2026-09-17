/**
 * Session API function definitions and schemas.
 */

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  sendSessionMessage,
  startSession,
  waitForSession,
  type SessionOperationContext,
} from "../models/session-operations.js";
import {
  getSession,
  listSessions,
} from "../session-store.js";
import { listSessionEntries } from "../messages-store.js";
import { Sessions } from "../models/sessions.js";
import { ThinkingLevelSchema } from "../models/model-settings.js";
import { type ApiContext, type ApiFunctionDef, defineFunction } from "./define-function.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sessionModel(ctx: ApiContext) {
  return new Sessions(ctx.sessions, ctx.broadcast);
}

function withUnread<T extends { activity_state: string | null }>(session: T) {
  return { ...session, unread: session.activity_state === "finished" };
}

function assertSessionExists(sessionId: string) {
  const session = getSession(sessionId);
  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }
  return session;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const SessionSchema = Type.Object({
  id: Type.String(),
  project_id: Type.Number(),
  name: Type.Union([Type.String(), Type.Null()]),
  created_at: Type.String(),
  updated_at: Type.String(),
  model_provider: Type.Union([Type.String(), Type.Null()]),
  model_id: Type.Union([Type.String(), Type.Null()]),
  thinking_level: Type.String(),
  agent_runtime_type: Type.String(),
  unread: Type.Boolean({ description: "Whether the session has an unread completion. API reads do not mark it read." }),
  activity_state: Type.Union([Type.Literal("running"), Type.Literal("finished"), Type.Null()], {
    description: "Persisted activity: finished means unread completion, running means active work, null means no pending activity. Reading via this API does not mark sessions read.",
  }),
  task_id: Type.Union([Type.Number(), Type.Null()]),
  parent_session_id: Type.Union([Type.String(), Type.Null()]),
  message_count: Type.Optional(Type.Number()),
  first_message: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

const SortOrderSchema = Type.Union([Type.Literal("asc"), Type.Literal("desc")]);
const CurrentIdSchema = Type.Literal("current");

const SessionListOptionsSchema = Type.Object({
  projectId: Type.Optional(Type.Union([Type.Number(), CurrentIdSchema])),
  taskId: Type.Optional(Type.Union([Type.Number(), Type.Null(), CurrentIdSchema])),
  since: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Number()),
  search: Type.Optional(Type.String()),
  minMessages: Type.Optional(Type.Number()),
});

const EntryTypeSchema = Type.Union([
  Type.Literal("user"),
  Type.Literal("assistant"),
  Type.Literal("compactionSummary"),
  Type.Literal("toolCall"),
]);

const EntryOptionsSchema = Type.Object({
  types: Type.Optional(Type.Array(EntryTypeSchema)),
  toolName: Type.Optional(Type.String()),
  isError: Type.Optional(Type.Boolean()),
  since: Type.Optional(Type.String()),
  afterSeq: Type.Optional(Type.Number()),
  beforeSeq: Type.Optional(Type.Number()),
  limit: Type.Optional(Type.Number()),
  search: Type.Optional(Type.String()),
  order: Type.Optional(SortOrderSchema),
  includeContent: Type.Optional(Type.Boolean()),
});

export const MessageEntrySchema = Type.Object({
  sessionId: Type.String(),
  seq: Type.Number(),
  created_at: Type.String(),
  type: Type.Union([Type.Literal("user"), Type.Literal("assistant"), Type.Literal("compactionSummary")]),
  role: Type.String(),
  content: Type.Optional(Type.Unknown()),
  summary: Type.Optional(Type.String()),
});

export const ToolCallResultSchema = Type.Object({
  seq: Type.Number(),
  created_at: Type.String(),
  isError: Type.Boolean(),
  contentPreview: Type.String(),
  content: Type.Optional(Type.Unknown()),
});

export const ToolCallEntrySchema = Type.Object({
  sessionId: Type.String(),
  seq: Type.Number(),
  created_at: Type.String(),
  type: Type.Literal("toolCall"),
  id: Type.String(),
  name: Type.String(),
  arguments: Type.Unknown(),
  result: Type.Union([ToolCallResultSchema, Type.Null()]),
});

export const SessionEntrySchema = Type.Union([MessageEntrySchema, ToolCallEntrySchema]);

// ---------------------------------------------------------------------------
// Function definitions
// ---------------------------------------------------------------------------

const sessionsListFunction = defineFunction({
  name: "sessions.list",
  description:
    "List sessions for a project. Call without options for all sessions in the current project. " +
    "Pass projectId to inspect another project, taskId for one task's sessions, or taskId: null " +
    "for scratch sessions only. Use taskId: \"current\" from a task session to list that task's sessions. " +
    "Session results include unread: true for unread completions, false otherwise. Reads do not mark sessions read.",
  parameters: Type.Object({ options: Type.Optional(SessionListOptionsSchema) }),
  returns: Type.Array(SessionSchema),
  tags: ["sessions", "list", "query", "read", "scratch", "filter", "search", "messages"],
  execute: (params, ctx) => {
    const options = params.options;
    const projectId = options?.projectId === "current" || options?.projectId === undefined
      ? ctx.projectId
      : options.projectId;
    const taskId = options?.taskId === "current" ? ctx.taskId : options?.taskId;

    return listSessions({
      projectId,
      taskId,
      includeTaskSessions: taskId === undefined,
      since: options?.since,
      limit: options?.limit,
      search: options?.search,
      minMessages: options?.minMessages,
    }).map(withUnread);
  },
});

const sessionsCurrentFunction = defineFunction({
  name: "sessions.current",
  description: "Get the current session (the one running this script), including unread status. No ID needed. Does not mark it read.",
  parameters: Type.Object({}),
  returns: SessionSchema,
  tags: ["sessions", "current", "read", "self", "context"],
  execute: (_params, ctx) => {
    const session = getSession(ctx.sessionId);
    if (!session) throw new Error(`Session ${ctx.sessionId} not found`);
    return withUnread(session);
  },
});

const sessionsGetFunction = defineFunction({
  name: "sessions.get",
  description: "Get a single session by ID, including unread status. Throws if not found. Does not mark it read.",
  parameters: Type.Object({ sessionId: Type.String() }),
  returns: SessionSchema,
  tags: ["sessions", "get", "read", "lookup"],
  execute: (params, _ctx) => withUnread(assertSessionExists(params.sessionId)),
});

const sessionsEntriesFunction = defineFunction({
  name: "sessions.entries",
  description:
    "List session timeline entries. Entries can include persisted user/assistant/compactionSummary " +
    "messages and derived toolCall entries. Pass options.types to narrow returned entry types; tool calls " +
    "include joined result previews when available, and raw result content only when includeContent is true.",
  parameters: Type.Object({
    sessionId: Type.String(),
    options: Type.Optional(EntryOptionsSchema),
  }),
  returns: Type.Array(SessionEntrySchema),
  tags: ["sessions", "entries", "messages", "read", "history", "conversation", "filter", "search", "prompts", "tools", "tool", "calls", "results", "trace", "errors"],
  execute: (params, _ctx) => {
    assertSessionExists(params.sessionId);
    return listSessionEntries(params.sessionId, params.options);
  },
});

export const sessionsSetModelFunction = defineFunction({
  name: "sessions.setModel",
  description:
    "Change the AI model for a session. Takes effect on the next LLM turn. " +
    "Use models.list() to discover available providers and model IDs. " +
    "The thinkingLevel parameter is optional and defaults to the session's current level.",
  parameters: Type.Object({
    sessionId: Type.String({ description: "Session ID to update." }),
    provider: Type.String({ description: "Provider name (e.g. 'anthropic', 'openai')." }),
    modelId: Type.String({ description: "Model ID (e.g. 'claude-sonnet-4-5')." }),
    thinkingLevel: Type.Optional(ThinkingLevelSchema),
  }),
  returns: SessionSchema,
  async: true,
  tags: ["sessions", "model", "set", "write", "switch", "provider"],
  execute: async (params, ctx) => {
    return withUnread(await sessionModel(ctx).setModel({ ...params, projectId: ctx.projectId }));
  },
});

const StartParameters = Type.Object({
  prompt: Type.String({ minLength: 1 }),
  options: Type.Object({
    parentSessionId: Type.Union([Type.Literal("current"), Type.Null()], { description: '"current" creates a child of the caller; null creates an independent session.' }),
    title: Type.Optional(Type.String({ minLength: 1 })),
    modelProvider: Type.Optional(Type.String({ minLength: 1 })),
    modelId: Type.Optional(Type.String({ minLength: 1 })),
    thinkingLevel: Type.Optional(ThinkingLevelSchema),
  }),
});
const SendParameters = Type.Object({
  sessionId: Type.String({ minLength: 1 }),
  message: Type.String({ minLength: 1 }),
});
const WaitParameters = Type.Object({
  sessionId: Type.String({ minLength: 1 }),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 30000 })),
});
export const SessionHandleSchema = Type.Object({ sessionId: Type.String() });
export const SessionWaitResultSchema = Type.Object({
  sessionId: Type.String(),
  status: Type.Union(["idle", "completed", "failed", "cancelled", "timeout"].map((status) => Type.Literal(status))),
  result: Type.Union([Type.String(), Type.Null()]),
  error: Type.Union([Type.String(), Type.Null()]),
});

function sessionOperations(ctx: ApiContext): SessionOperationContext {
  return {
    callerId: ctx.sessionId,
    sessions: ctx.sessions,
    broadcast: ctx.broadcast,
    createSession: ctx.createSession,
    openSession: ctx.openSession,
  };
}

const sessionsStartFunction = defineFunction({
  name: "sessions.start",
  description: "Start a fresh session in the caller's project/task and return its sessionId without waiting for completion. " +
    'options.parentSessionId is required: "current" for a child, null for an independent session. ' +
    "Optional title uses the session name; omitted title preserves normal naming. Model/thinking default to the caller. " +
    "Sessions share the checkout: coordinate file edits. Only start other agents when the user explicitly asks for delegation or parallel sessions. Children report their latest outcome on runtime settlement, durably prompting idle parents or steering busy ones. Reports are not queued or retried. Continue other work or end your turn rather than polling. Independent sessions require explicit result retrieval.",
  parameters: StartParameters,
  returns: SessionHandleSchema,
  async: true,
  tags: ["sessions", "start", "create", "delegate", "async", "parent", "title"],
  execute: async (params, ctx) => {
    if (!Value.Check(StartParameters, params)) throw new Error("Invalid session start parameters; options.parentSessionId must be current or null");
    if (ctx.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return startSession(sessionOperations(ctx), params.prompt, params.options);
  },
});
const sessionsSendFunction = defineFunction({
  name: "sessions.send",
  description: "Send a message to a session in the caller's project/task. Reopens it if necessary. " +
    "Idle sessions start a prompt; busy sessions receive native steering without cancellation/restart. " +
    "Idle delivery is durably accepted before execution; busy delivery forwards directly to AgentHarness steering. " +
    "No Reins-managed queued follow-ups, deferred delivery, or automatic restart. Pi uses native idle state and does not serialize concurrent startup sends. Returns without waiting for response completion.",
  parameters: SendParameters,
  returns: SessionHandleSchema,
  async: true,
  tags: ["sessions", "send", "message", "steer", "resume", "async"],
  execute: async (params, ctx) => {
    if (!Value.Check(SendParameters, params)) throw new Error("Invalid send parameters; sessionId and message must be non-empty strings");
    if (ctx.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return sendSessionMessage(sessionOperations(ctx), params.sessionId, params.message);
  },
});
const sessionsWaitFunction = defineFunction({
  name: "sessions.wait",
  description: "Observe native idleness for a session in the caller's project/task, including native steering and compaction, then return its latest response/outcome. " +
    "timeoutMs defaults to 10000, maximum 30000; 0 checks immediately. Timeout or cancelling this script never cancels the target. " +
    "Already-settled sessions return immediately. Pi uses native idleness, which may report idle during startup; an immediate wait can return before work begins. " +
    "Pi returns the latest transcript outcome, not a retained prompt failure. Closed sessions read persisted history; transient execution failures are not recovered after restart. Children automatically report to their parent when new work settles, so explicit waiting is optional. Cannot wait for yourself.",
  parameters: WaitParameters,
  returns: SessionWaitResultSchema,
  async: true,
  tags: ["sessions", "wait", "settled", "result", "async", "timeout"],
  execute: async (params, ctx) => {
    if (!Value.Check(WaitParameters, params)) throw new Error("Invalid wait parameters; timeoutMs must be between 0 and 30000");
    return waitForSession(sessionOperations(ctx), params.sessionId, params.timeoutMs, ctx.signal);
  },
});

export const SESSION_FUNCTIONS: ApiFunctionDef[] = [
  sessionsStartFunction,
  sessionsSendFunction,
  sessionsWaitFunction,
  sessionsListFunction,
  sessionsCurrentFunction,
  sessionsGetFunction,
  sessionsEntriesFunction,
  sessionsSetModelFunction,
];

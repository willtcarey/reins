/**
 * Session API function definitions and schemas.
 */

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { SessionOrchestration } from "../models/session-orchestration.js";
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
  mode: Type.Union([Type.Literal("queue"), Type.Literal("steer")]),
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

function orchestration(ctx: ApiContext): SessionOrchestration {
  return new SessionOrchestration(ctx.sessionId, ctx.sessions, ctx.broadcast, ctx.createSession, ctx.openSession);
}

const sessionsStartFunction = defineFunction({
  name: "sessions.start",
  description: "Start a fresh session in the caller's project/task and return its sessionId without waiting for completion. " +
    'options.parentSessionId is required: "current" for a child, null for an independent session. ' +
    "Optional title uses the session name; omitted title preserves normal naming. Model/thinking default to the caller. " +
    "Sessions share the checkout: coordinate file edits. Only start other agents when the user explicitly asks for delegation or parallel sessions. Use sessions.wait to retrieve results.",
  parameters: StartParameters,
  returns: SessionHandleSchema,
  async: true,
  tags: ["sessions", "start", "create", "delegate", "async", "parent", "title"],
  execute: async (params, ctx) => {
    if (!Value.Check(StartParameters, params)) throw new Error("Invalid session start parameters; options.parentSessionId must be current or null");
    if (ctx.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return orchestration(ctx).start(params.prompt, params.options);
  },
});
const sessionsSendFunction = defineFunction({
  name: "sessions.send",
  description: "Send a message to a session in the caller's project/task. Reopens it if necessary. " +
    "Idle sessions start work for either mode. Busy queue waits until current work finishes; steer uses native steering without cancellation/restart. " +
    "Unsupported steering rejects, never silently queues. Claude also rejects busy queue requests; wait for settlement and send again. " +
    "During standalone compaction, Pi sends wait for native idleness before delivering. Pi uses native idle state and does not serialize concurrent startup sends. Returns without waiting for response completion.",
  parameters: SendParameters,
  returns: SessionHandleSchema,
  async: true,
  tags: ["sessions", "send", "message", "queue", "steer", "followup", "async"],
  execute: async (params, ctx) => {
    if (!Value.Check(SendParameters, params)) throw new Error("Invalid send parameters; mode must be queue or steer");
    if (ctx.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return orchestration(ctx).send(params.sessionId, params.message, params.mode);
  },
});
const sessionsWaitFunction = defineFunction({
  name: "sessions.wait",
  description: "Wait until a session in the caller's project/task is fully settled, including all queued follow-ups and steering, then return its latest response/outcome. " +
    "timeoutMs defaults to 10000, maximum 30000; 0 checks immediately. Timeout or cancelling this script never cancels the target. " +
    "Already-settled sessions return immediately. Pi uses native idleness, which may report idle during startup; an immediate wait can return before work begins. " +
    "Pi returns the latest transcript outcome, not a retained prompt failure. Closed sessions read persisted history; transient execution failures are not recovered after restart. No automatic parent wakeup. Cannot wait for yourself.",
  parameters: WaitParameters,
  returns: SessionWaitResultSchema,
  async: true,
  tags: ["sessions", "wait", "settled", "result", "async", "timeout"],
  execute: async (params, ctx) => {
    if (!Value.Check(WaitParameters, params)) throw new Error("Invalid wait parameters; timeoutMs must be between 0 and 30000");
    return orchestration(ctx).wait(params.sessionId, params.timeoutMs, ctx.signal);
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

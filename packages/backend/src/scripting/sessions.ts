/**
 * Session API function definitions and schemas.
 */

import { Type } from "@sinclair/typebox";
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
  Type.Literal("toolResult"),
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

export const ToolResultEntrySchema = Type.Object({
  sessionId: Type.String(),
  seq: Type.Number(),
  created_at: Type.String(),
  type: Type.Literal("toolResult"),
  role: Type.Literal("toolResult"),
  toolCallId: Type.String(),
  toolName: Type.String(),
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
});

export const SessionEntrySchema = Type.Union([MessageEntrySchema, ToolCallEntrySchema, ToolResultEntrySchema]);

// ---------------------------------------------------------------------------
// Function definitions
// ---------------------------------------------------------------------------

const sessionsListFunction = defineFunction({
  name: "sessions.list",
  description:
    "List sessions for a project. Call without options for all sessions in the current project. " +
    "Pass projectId to inspect another project, taskId for one task's sessions, or taskId: null " +
    "for scratch sessions only. Use taskId: \"current\" from a task session to list that task's sessions.",
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
    });
  },
});

const sessionsListForTaskFunction = defineFunction({
  name: "sessions.listForTask",
  description: "List sessions belonging to a specific task.",
  parameters: Type.Object({ taskId: Type.Number() }),
  returns: Type.Array(SessionSchema),
  tags: ["sessions", "list", "query", "read", "task"],
  execute: (params, _ctx) => listSessions({ taskId: params.taskId }),
});

const sessionsCurrentFunction = defineFunction({
  name: "sessions.current",
  description: "Get the current session (the one running this script). No ID needed.",
  parameters: Type.Object({}),
  returns: SessionSchema,
  tags: ["sessions", "current", "read", "self", "context"],
  execute: (_params, ctx) => {
    const session = getSession(ctx.sessionId);
    if (!session) throw new Error(`Session ${ctx.sessionId} not found`);
    return session;
  },
});

const sessionsGetFunction = defineFunction({
  name: "sessions.get",
  description: "Get a single session by ID. Throws if not found.",
  parameters: Type.Object({ sessionId: Type.String() }),
  returns: SessionSchema,
  tags: ["sessions", "get", "read", "lookup"],
  execute: (params, _ctx) => assertSessionExists(params.sessionId),
});

const sessionsEntriesFunction = defineFunction({
  name: "sessions.entries",
  description:
    "List session timeline entries. Entries can include persisted user/assistant/toolResult/compactionSummary " +
    "messages and derived toolCall entries. Pass options.types to narrow returned entry types; tool results " +
    "include contentPreview by default and raw content only when includeContent is true.",
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
    modelId: Type.String({ description: "Model ID (e.g. 'claude-sonnet-4-20250514')." }),
    thinkingLevel: Type.Optional(ThinkingLevelSchema),
  }),
  returns: SessionSchema,
  async: true,
  tags: ["sessions", "model", "set", "write", "switch", "provider"],
  execute: async (params, ctx) => {
    return sessionModel(ctx).setModel({ ...params, projectId: ctx.projectId });
  },
});

export const SESSION_FUNCTIONS: ApiFunctionDef[] = [
  sessionsListFunction,
  sessionsListForTaskFunction,
  sessionsCurrentFunction,
  sessionsGetFunction,
  sessionsEntriesFunction,
  sessionsSetModelFunction,
];

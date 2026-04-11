/**
 * Session API function definitions and schemas.
 */

import { Type } from "@sinclair/typebox";
import {
  getSession,
  listSessionRows,
  listTaskSessionRows,
  loadMessages,
} from "../session-store.js";
import { Sessions } from "../models/sessions.js";
import { ThinkingLevelSchema } from "../models/model-settings.js";
import { type ApiContext, type ApiFunctionDef, defineFunction } from "./define-function.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sessionModel(ctx: ApiContext) {
  return new Sessions(ctx.sessions, ctx.broadcast);
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
});

export const MessageSchema = Type.Object({
  role: Type.String(),
  content: Type.Array(Type.Unknown()),
});

// ---------------------------------------------------------------------------
// Function definitions
// ---------------------------------------------------------------------------

const sessionsListFunction = defineFunction({
  name: "sessions.list",
  description: "List scratch sessions (non-task) for the current project.",
  parameters: Type.Object({}),
  returns: Type.Array(SessionSchema),
  tags: ["sessions", "list", "query", "read", "scratch"],
  execute: (_params, ctx) => listSessionRows(ctx.projectId),
});

const sessionsListForTaskFunction = defineFunction({
  name: "sessions.listForTask",
  description: "List sessions belonging to a specific task.",
  parameters: Type.Object({ taskId: Type.Number() }),
  returns: Type.Array(SessionSchema),
  tags: ["sessions", "list", "query", "read", "task"],
  execute: (params, _ctx) => listTaskSessionRows(params.taskId),
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
  execute: (params, ctx) => {
    const session = getSession(params.sessionId);
    if (!session || session.project_id !== ctx.projectId) {
      throw new Error(`Session ${params.sessionId} not found`);
    }
    return session;
  },
});

const sessionsMessagesFunction = defineFunction({
  name: "sessions.messages",
  description: "Load all persisted messages for a session, ordered by sequence number.",
  parameters: Type.Object({ sessionId: Type.String() }),
  returns: Type.Array(MessageSchema),
  tags: ["sessions", "messages", "read", "history", "conversation"],
  execute: (params, ctx) => {
    // Verify session belongs to this project before loading messages
    const session = getSession(params.sessionId);
    if (!session || session.project_id !== ctx.projectId) {
      throw new Error(`Session ${params.sessionId} not found`);
    }
    return loadMessages(params.sessionId);
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
  sessionsMessagesFunction,
  sessionsSetModelFunction,
];

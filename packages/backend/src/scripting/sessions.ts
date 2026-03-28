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
import { type ApiFunctionDef, defineFunction } from "./api-registry.js";

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

export const SESSION_FUNCTIONS: ApiFunctionDef[] = [
  defineFunction({
    name: "sessions.list",
    description: "List scratch sessions (non-task) for the current project.",
    parameters: Type.Object({}),
    returns: Type.Array(SessionSchema),
    tags: ["sessions", "list", "query", "read", "scratch"],
    execute: (_params, ctx) => listSessionRows(ctx.projectId),
  }),
  defineFunction({
    name: "sessions.listForTask",
    description: "List sessions belonging to a specific task.",
    parameters: Type.Object({ taskId: Type.Number() }),
    returns: Type.Array(SessionSchema),
    tags: ["sessions", "list", "query", "read", "task"],
    execute: (params, _ctx) => listTaskSessionRows(params.taskId),
  }),
  defineFunction({
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
  }),
  defineFunction({
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
  }),
  defineFunction({
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
  }),
];

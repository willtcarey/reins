/**
 * Session API function definitions and schemas.
 */

import { Type } from "@sinclair/typebox";
import { getModels, getProviders } from "@mariozechner/pi-ai";
import type { ThinkingLevel } from "@mariozechner/pi-ai";
import {
  getSession,
  listSessionRows,
  listTaskSessionRows,
  loadMessages,
  updateSessionMeta,
} from "../session-store.js";
import { type ApiFunctionDef, defineFunction } from "./define-function.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const THINKING_LEVELS: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh"];

function validateThinkingLevel(level: string): ThinkingLevel {
  const found = THINKING_LEVELS.find((l) => l === level);
  if (!found) {
    throw new Error(
      `Invalid thinking level '${level}'. Valid levels: ${THINKING_LEVELS.join(", ")}`,
    );
  }
  return found;
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
  defineFunction({
    name: "sessions.setModel",
    description:
      "Change the AI model for a session. Takes effect on the next LLM turn. " +
      "Use models.list() to discover available providers and model IDs. " +
      "The thinkingLevel parameter is optional and defaults to the session's current level.",
    parameters: Type.Object({
      sessionId: Type.String({ description: "Session ID to update." }),
      provider: Type.String({ description: "Provider name (e.g. 'anthropic', 'openai')." }),
      modelId: Type.String({ description: "Model ID (e.g. 'claude-sonnet-4-20250514')." }),
      thinkingLevel: Type.Optional(
        Type.String({ description: "Thinking level (e.g. 'off', 'low', 'medium', 'high'). Optional." }),
      ),
    }),
    returns: SessionSchema,
    async: true,
    tags: ["sessions", "model", "set", "write", "switch", "provider"],
    execute: async (params, ctx) => {
      // Validate session exists and belongs to this project
      const sessionRow = getSession(params.sessionId);
      if (!sessionRow || sessionRow.project_id !== ctx.projectId) {
        throw new Error(`Session ${params.sessionId} not found`);
      }

      // Look up the ManagedSession (must be open in memory)
      const managed = ctx.sessions.get(params.sessionId);
      if (!managed) {
        throw new Error(`Session ${params.sessionId} is not currently open`);
      }

      // Validate provider
      const providers = getProviders();
      const provider = providers.find((p) => p === params.provider);
      if (!provider) {
        throw new Error(
          `Unknown provider '${params.provider}'. Available providers: ${providers.join(", ")}`,
        );
      }

      // Resolve the model from pi-ai
      const models = getModels(provider);
      const model = models.find((m) => m.id === params.modelId);
      if (!model) {
        throw new Error(
          `Model '${params.modelId}' not found for provider '${params.provider}'. ` +
            `Available models: ${models.map((m) => m.id).join(", ")}`,
        );
      }

      // Set the model on the pi SDK session
      await managed.session.setModel(model);

      // Set thinking level if provided
      const thinkingLevel = params.thinkingLevel ?? managed.session.thinkingLevel;
      if (params.thinkingLevel) {
        const level = validateThinkingLevel(params.thinkingLevel);
        managed.session.setThinkingLevel(level);
      }

      // Update the SQLite row
      updateSessionMeta(params.sessionId, {
        modelProvider: params.provider,
        modelId: params.modelId,
        thinkingLevel,
      });

      // Broadcast the change
      ctx.broadcast({
        type: "session_model_changed",
        sessionId: params.sessionId,
        projectId: ctx.projectId,
        provider: params.provider,
        modelId: params.modelId,
        thinkingLevel,
      });

      // Return the updated session row
      const updated = getSession(params.sessionId);
      if (!updated) throw new Error(`Session ${params.sessionId} not found after update`);
      return updated;
    },
  }),
];

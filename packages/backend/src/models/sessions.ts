/**
 * Project Sessions
 *
 * Business logic for project-scoped session operations.
 * Orchestrates session-store persistence, pi SDK live session updates,
 * and WebSocket broadcasts.
 */

import { getModels, getProviders } from "@mariozechner/pi-ai";
import type { ThinkingLevel } from "@mariozechner/pi-ai";
import {
  getSession,
  updateSessionMeta,
  type SessionRow,
} from "../session-store.js";
import type { Broadcast } from "./broadcast.js";
import type { ManagedSession } from "../state.js";

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

export interface SetSessionModelParams {
  sessionId: string;
  provider: string;
  modelId: string;
  thinkingLevel?: string;
}

export class ProjectSessions {
  constructor(
    private projectId: number,
    private sessions: Map<string, ManagedSession>,
    private broadcast: Broadcast,
  ) {}

  /**
   * Change the AI model for a session.
   *
   * If the session is currently open in memory, the change is applied live
   * for the next LLM turn and broadcast to connected clients. Inactive
   * sessions are updated in SQLite only.
   */
  async setModel(params: SetSessionModelParams): Promise<SessionRow> {
    const sessionRow = getSession(params.sessionId);
    if (!sessionRow || sessionRow.project_id !== this.projectId) {
      throw new Error(`Session ${params.sessionId} not found`);
    }

    const managed = this.sessions.get(params.sessionId);

    const providers = getProviders();
    const provider = providers.find((p) => p === params.provider);
    if (!provider) {
      throw new Error(
        `Unknown provider '${params.provider}'. Available providers: ${providers.join(", ")}`,
      );
    }

    const models = getModels(provider);
    const model = models.find((m) => m.id === params.modelId);
    if (!model) {
      throw new Error(
        `Model '${params.modelId}' not found for provider '${params.provider}'. ` +
          `Available models: ${models.map((m) => m.id).join(", ")}`,
      );
    }

    const thinkingLevel = params.thinkingLevel
      ? validateThinkingLevel(params.thinkingLevel)
      : sessionRow.thinking_level;
    const liveThinkingLevel = params.thinkingLevel ? validateThinkingLevel(params.thinkingLevel) : null;

    if (managed) {
      await managed.session.setModel(model);
      if (liveThinkingLevel) {
        managed.session.setThinkingLevel(liveThinkingLevel);
      }
    }

    updateSessionMeta(params.sessionId, {
      modelProvider: params.provider,
      modelId: params.modelId,
      thinkingLevel,
    });

    if (managed) {
      this.broadcast({
        type: "session_model_changed",
        sessionId: params.sessionId,
        projectId: this.projectId,
        provider: params.provider,
        modelId: params.modelId,
        thinkingLevel,
      });
    }

    const updated = getSession(params.sessionId);
    if (!updated) throw new Error(`Session ${params.sessionId} not found after update`);
    return updated;
  }
}

/**
 * Project Sessions
 *
 * Business logic for project-scoped session operations.
 * Orchestrates session-store persistence, pi SDK live session updates,
 * and WebSocket broadcasts.
 */

import {
  getSession,
  updateSessionMeta,
  type SessionRow,
} from "../session-store.js";
import type { Broadcast } from "./broadcast.js";
import type { ManagedSession } from "../state.js";
import { parseThinkingLevel } from "./model-settings.js";
import { getProject } from "../project-store.js";
import { createPiRuntimeForCwd } from "../pi/runtime.js";
import { getPiSession } from "../runtimes/pi/runtime.js";

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
   * for the next LLM turn. All session metadata changes broadcast a generic
   * session_updated event so clients can reload the canonical session state.
   */
  async setModel(params: SetSessionModelParams): Promise<SessionRow> {
    const sessionRow = getSession(params.sessionId);
    if (!sessionRow || sessionRow.project_id !== this.projectId) {
      throw new Error(`Session ${params.sessionId} not found`);
    }

    const managed = this.sessions.get(params.sessionId);
    const project = getProject(this.projectId);
    if (!project) {
      throw new Error(`Project ${this.projectId} not found`);
    }

    const { modelRegistry } = await createPiRuntimeForCwd({
      cwd: project.path,
    });
    const providers = Array.from(new Set(modelRegistry.getAll().map((candidate) => candidate.provider))).toSorted();
    if (!providers.includes(params.provider)) {
      throw new Error(
        `Unknown provider '${params.provider}'. Available providers: ${providers.join(", ")}`,
      );
    }

    const models = modelRegistry.getAll().filter((candidate) => candidate.provider === params.provider);
    const model = models.find((candidate) => candidate.id === params.modelId);
    if (!model) {
      throw new Error(
        `Model '${params.modelId}' not found for provider '${params.provider}'. ` +
        `Available models: ${models.map((candidate) => candidate.id).join(", ")}`,
      );
    }

    const thinkingLevel = params.thinkingLevel
      ? parseThinkingLevel(params.thinkingLevel)
      : sessionRow.thinking_level;
    const liveThinkingLevel = params.thinkingLevel ? parseThinkingLevel(params.thinkingLevel) : null;

    if (managed) {
      const session = getPiSession(managed.runtime);
      await session.setModel(model);
      if (liveThinkingLevel) {
        session.setThinkingLevel(liveThinkingLevel);
      }
    }

    updateSessionMeta(params.sessionId, {
      modelProvider: params.provider,
      modelId: params.modelId,
      thinkingLevel,
    });

    this.broadcast({
      type: "session_updated",
      sessionId: params.sessionId,
      projectId: this.projectId,
    });

    const updated = getSession(params.sessionId);
    if (!updated) throw new Error(`Session ${params.sessionId} not found after update`);
    return updated;
  }
}

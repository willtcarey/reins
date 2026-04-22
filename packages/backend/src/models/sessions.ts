/**
 * Sessions
 *
 * Business logic for session read/write operations.
 * Handles session-store reads, optional live runtime overlays,
 * and metadata updates/broadcasts.
 */

import {
  getSession,
  listSessions,
  listTaskSessions,
  loadMessages,
  updateSessionMeta,
  type SessionListItem,
  type SessionRow,
} from "../session-store.js";
import type { Broadcast } from "./broadcast.js";
import type { ManagedSession } from "../state.js";
import { parseThinkingLevel } from "./model-settings.js";
import { getRuntimeAdapter, type AgentRuntimeMessage } from "../runtimes/registry.js";
import { stripLeadingSkillBlocks } from "./skill.js";

export interface SetSessionModelParams {
  sessionId: string;
  runtimeType?: string;
  provider: string;
  modelId: string;
  thinkingLevel?: string;
  projectId?: number;
}

export interface SessionView {
  id: string;
  project_id: number;
  task_id: number | null;
  runtimeType: string;
  state: {
    model: { provider: string; id: string } | null;
    thinkingLevel: string;
    isStreaming: boolean;
    messageCount: number;
  };
}

interface TextBlock {
  type: "text";
  text: string;
  [key: string]: unknown;
}

function isTextBlock(value: unknown): value is TextBlock {
  if (typeof value !== "object" || value === null) return false;
  const obj: Record<string, unknown> = value;
  return obj.type === "text" && typeof obj.text === "string";
}

/**
 * Strip leading `<skill>` blocks from a user message's visible text so
 * historical messages don't render walls of hoisted skill content. The
 * expanded form stays in the DB for runtime replay / compaction.
 */
function stripUserSkillBlocks(msg: AgentRuntimeMessage): AgentRuntimeMessage {
  if (msg.role !== "user") return msg;
  const { content } = msg;
  if (typeof content === "string") {
    const stripped = stripLeadingSkillBlocks(content);
    if (stripped === content) return msg;
    return { ...msg, content: stripped ?? content };
  }
  if (Array.isArray(content)) {
    const idx = content.findIndex(isTextBlock);
    if (idx < 0) return msg;
    const block = content[idx];
    if (!isTextBlock(block)) return msg;
    const stripped = stripLeadingSkillBlocks(block.text);
    if (stripped === block.text) return msg;
    const nextContent = content.slice();
    nextContent[idx] = { ...block, text: stripped ?? block.text };
    return { ...msg, content: nextContent };
  }
  return msg;
}

export class Sessions {
  constructor(
    private sessions: Map<string, ManagedSession>,
    private broadcast: Broadcast = () => {},
  ) {}

  get(sessionId: string): SessionView | null {
    const row = getSession(sessionId);
    if (!row) return null;

    const isStreaming = this.sessions.get(sessionId)?.runtime.isStreaming() ?? false;

    return {
      id: row.id,
      project_id: row.project_id,
      task_id: row.task_id,
      runtimeType: row.agent_runtime_type,
      state: {
        model: row.model_provider && row.model_id
          ? { provider: row.model_provider, id: row.model_id }
          : null,
        thinkingLevel: row.thinking_level,
        isStreaming,
        messageCount: loadMessages(sessionId).length,
      },
    };
  }

  getMessages(sessionId: string): AgentRuntimeMessage[] | null {
    const row = getSession(sessionId);
    if (!row) return null;
    const messages: AgentRuntimeMessage[] = loadMessages(sessionId);
    return messages.map(stripUserSkillBlocks);
  }

  listByProject(projectId: number): SessionListItem[] {
    return listSessions(projectId);
  }

  listByTask(taskId: number): SessionListItem[] {
    return listTaskSessions(taskId);
  }

  /**
   * Change the AI model for a session.
   *
   * If the session is currently open in memory, the change is applied live
   * for the next LLM turn. All session metadata changes broadcast a generic
   * session_updated event so clients can reload the canonical session state.
   */
  async setModel(params: SetSessionModelParams): Promise<SessionRow> {
    const sessionRow = getSession(params.sessionId);
    if (!sessionRow || (params.projectId !== undefined && sessionRow.project_id !== params.projectId)) {
      throw new Error(`Session ${params.sessionId} not found`);
    }

    const managed = this.sessions.get(params.sessionId);
    const nextRuntimeType = params.runtimeType ?? sessionRow.agent_runtime_type;
    const isRuntimeSwitch = nextRuntimeType !== sessionRow.agent_runtime_type;
    const messageCount = loadMessages(params.sessionId).length;

    if (isRuntimeSwitch) {
      if (messageCount > 0) {
        throw new Error("Session runtime can only be changed before any messages are sent");
      }
      if (managed?.runtime.isStreaming()) {
        throw new Error("Session runtime cannot be changed while the session is streaming");
      }
    }

    const runtimeAdapter = getRuntimeAdapter(nextRuntimeType);
    const providers = await runtimeAdapter.listModels();
    const provider = providers.find((candidate) => candidate.provider === params.provider);
    if (!provider) {
      const availableProviders = providers.map((candidate) => candidate.provider).toSorted();
      throw new Error(
        `Unknown provider '${params.provider}'. Available providers: ${availableProviders.join(", ")}`,
      );
    }

    if (!provider.models.some((candidate) => candidate.id === params.modelId)) {
      throw new Error(
        `Model '${params.modelId}' not found for provider '${params.provider}'. ` +
        `Available models: ${provider.models.map((candidate) => candidate.id).join(", ")}`,
      );
    }

    const liveThinkingLevel = params.thinkingLevel ? parseThinkingLevel(params.thinkingLevel) : null;
    const thinkingLevel = liveThinkingLevel ?? sessionRow.thinking_level;

    if (managed && isRuntimeSwitch) {
      await managed.runtime.close();
      this.sessions.delete(params.sessionId);
    } else if (managed) {
      await managed.runtime.setModel({
        provider: params.provider,
        modelId: params.modelId,
        thinkingLevel: liveThinkingLevel,
      });
    }

    updateSessionMeta(params.sessionId, {
      modelProvider: params.provider,
      modelId: params.modelId,
      thinkingLevel,
      agentRuntimeType: nextRuntimeType,
    });

    this.broadcast({
      type: "session_updated",
      sessionId: params.sessionId,
      projectId: sessionRow.project_id,
    });

    const updated = getSession(params.sessionId);
    if (!updated) throw new Error(`Session ${params.sessionId} not found after update`);
    return updated;
  }
}

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
  updateSessionMeta,
  type SessionRow,
} from "../session-store.js";
import { loadMessages, type RuntimeMessage } from "../messages-store.js";
import {
  MAX_PROMPT_ATTACHMENT_BYTES,
  getSessionAttachment,
  storeSessionAttachment,
  type SessionAttachmentInfo,
} from "../session-attachments-store.js";
import type { Broadcast } from "./broadcast.js";
import { UploadedFile } from "./uploaded-file.js";
import type { ManagedSession } from "../state.js";
import { parseThinkingLevel } from "./model-settings.js";
import { getRuntimeAdapter } from "../runtimes/registry.js";
import { stripLeadingSkillBlocks } from "./skill.js";

export interface SetSessionModelParams {
  sessionId: string;
  runtimeType?: string;
  provider: string;
  modelId: string;
  thinkingLevel?: string;
  projectId?: number;
}

export class SessionNotFoundError extends Error {
  constructor(message = "Session not found") {
    super(message);
    this.name = "SessionNotFoundError";
  }
}

export class SessionAttachmentNotFoundError extends Error {
  constructor() {
    super("Attachment not found");
    this.name = "SessionAttachmentNotFoundError";
  }
}

export class SessionAttachmentPrunedError extends Error {
  constructor() {
    super("Attachment data has been pruned");
    this.name = "SessionAttachmentPrunedError";
  }
}

export class SessionAttachmentUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionAttachmentUploadError";
  }
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

export interface SessionAttachmentBytes {
  data: Buffer;
  mimeType: string;
}

interface TextBlock {
  type: "text";
  text: string;
  [key: string]: unknown;
}

function isTextBlock(value: unknown): value is TextBlock {
  if (typeof value !== "object" || value === null) return false;
  return "type" in value && value.type === "text" && "text" in value && typeof value.text === "string";
}

/**
 * Strip leading `<skill>` blocks from a user message's visible text so
 * historical messages don't render walls of hoisted skill content. The
 * expanded form stays in the DB for runtime replay / compaction.
 */
function stripUserSkillBlocks(msg: RuntimeMessage): RuntimeMessage {
  if (msg.role !== "user") return msg;
  const { content } = msg;
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

  getMessages(sessionId: string): RuntimeMessage[] | null {
    const row = getSession(sessionId);
    if (!row) return null;
    const messages: RuntimeMessage[] = loadMessages(sessionId);
    return messages.map(stripUserSkillBlocks);
  }

  async uploadAttachments(sessionId: string, files: File[]): Promise<SessionAttachmentInfo[]> {
    const row = getSession(sessionId);
    if (!row) throw new SessionNotFoundError();
    if (files.length === 0) throw new SessionAttachmentUploadError("No files uploaded");

    const uploadedFiles = files.map((file) => new UploadedFile(file));

    let declaredTotalBytes = 0;
    for (const upload of uploadedFiles) {
      try {
        upload.assertSupportedImageAttachment();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Invalid attachment";
        throw new SessionAttachmentUploadError(message);
      }
      declaredTotalBytes += upload.declaredByteSize;
      if (declaredTotalBytes > MAX_PROMPT_ATTACHMENT_BYTES) {
        throw new SessionAttachmentUploadError(`Attachments exceed ${MAX_PROMPT_ATTACHMENT_BYTES} byte prompt limit`);
      }
    }

    let actualTotalBytes = 0;
    const attachments: SessionAttachmentInfo[] = [];

    for (const upload of uploadedFiles) {
      try {
        const input = await upload.toImageAttachmentInput();
        actualTotalBytes += input.data.length;
        if (actualTotalBytes > MAX_PROMPT_ATTACHMENT_BYTES) {
          throw new Error(`Attachments exceed ${MAX_PROMPT_ATTACHMENT_BYTES} byte prompt limit`);
        }

        attachments.push(storeSessionAttachment(sessionId, input));
      } catch (err) {
        const message = err instanceof Error ? err.message : "Invalid attachment";
        throw new SessionAttachmentUploadError(message);
      }
    }

    return attachments;
  }

  getAttachmentBytes(sessionId: string, attachmentId: string): SessionAttachmentBytes {
    const row = getSession(sessionId);
    if (!row) throw new SessionNotFoundError();

    const attachment = getSessionAttachment(sessionId, attachmentId);
    if (!attachment) throw new SessionAttachmentNotFoundError();
    if (!attachment.data) throw new SessionAttachmentPrunedError();

    return { data: attachment.data, mimeType: attachment.mime_type };
  }

  listByProject(projectId: number): SessionRow[] {
    return listSessions({ projectId, taskId: null });
  }

  listByTask(taskId: number): SessionRow[] {
    return listSessions({ taskId });
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

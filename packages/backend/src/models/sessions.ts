/**
 * Sessions
 *
 * Business logic for session read/write operations: session views read from the server's rows and
 * replica (sessions run on nodes; there is no live runtime on the server), metadata updates, model
 * changes and moves, and their broadcasts.
 */

import {
  getSession,
  listSessions,
  listSessionsWithActivity,
  updateActivityState,
  updateSessionMeta,
  updateSessionMetadata,
  type PlacementStatus,
  type SessionMetadataUpdates,
  type SessionRow,
} from "../session-store.js";
import {
  countMessages,
  loadMessagePage,
  type PersistedMessage,
  type SessionMessagePage,
} from "../messages-store.js";
import {
  MAX_PROMPT_ATTACHMENT_BYTES,
  getSessionAttachment,
  storeSessionAttachment,
  type SessionAttachmentInfo,
} from "../session-attachments-store.js";
import type { Broadcast } from "./broadcast.js";
import { UploadedFile } from "./uploaded-file.js";
import { parseThinkingLevel } from "./model-settings.js";
import {
  buildSessionContextSnapshot,
  type SessionContextSnapshot,
} from "./session-context.js";
import { stripLeadingSkillBlocks } from "./skill.js";
import { getDb } from "../db.js";
import { readPendingPiOperation, type PendingPiOperation } from "../runtimes/pi/pending-operation.js";
import { DEFAULT_COMPACTION_SETTINGS } from "@earendil-works/pi-agent-core";
import { findPiModel } from "../runtimes/pi/model-catalog.js";
import { enqueueSetModel } from "../node-command-store.js";
import { getNode, getSource } from "../node-store.js";
import { nodeSessionActivity } from "./node-session-activity.js";
import { queueHydrationForUse, requestSessionMove, sessionLocation, sessionMoveTargets, type SessionMoveTarget } from "./session-ownership.js";

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
  projectId: number;
  taskId: number | null;
  parentSessionId: string | null;
  name: string | null;
  createdAt: string;
  updatedAt: string;
  activityState: SessionRow["activity_state"];
  placement: SessionPlacementView;
  pinnedAt: string | null;
  archivedAt: string | null;
}

/**
 * Where the session lives (`placement_status`) and a failure's reason. `nodeId`/`nodeName`: the node it
 * is on, being provisioned on or moving to (absent at rest on the server). `available` is false while
 * its source is not on a node that can be reached (queued provisioning or moves wait).
 */
export interface SessionPlacementView {
  status: PlacementStatus;
  error: string | null;
  available: boolean;
  nodeId?: string;
  nodeName?: string;
}

function toPlacementView(row: SessionRow): SessionPlacementView {
  const nodeId = getSource(row.source_id)?.node_id;
  const placement = { status: row.placement_status, error: row.status_error, available: nodeId === "internal" };
  if (row.placement_status === "server") return placement;
  const node = nodeId ?? "unknown";
  return { ...placement, nodeId: node, nodeName: getNode(node)?.name ?? node };
}

export interface SessionDetailView extends SessionView {
  pendingOperation: PendingPiOperation | null;
  messageCount: number;
  runtimeType?: string;
  state: {
    model: { provider: string; id: string } | null;
    thinkingLevel: string;
  };
}

export interface SessionListView extends SessionView {
  messageCount: number;
  firstMessage: string | null;
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

function toSessionView(row: SessionRow): SessionView {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    parentSessionId: row.parent_session_id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    activityState: row.activity_state,
    placement: toPlacementView(row),
    pinnedAt: row.pinned_at,
    archivedAt: row.archived_at,
  };
}

function toSessionListView(row: SessionRow): SessionListView {
  return {
    ...toSessionView(row),
    messageCount: row.message_count ?? 0,
    firstMessage: row.first_message ?? null,
  };
}

/**
 * Strip leading `<skill>` blocks from a user message's visible text so
 * historical messages don't render walls of hoisted skill content. The
 * expanded form stays in the DB for runtime replay / compaction.
 */
function strippedTextBlock(content: readonly unknown[]): { index: number; block: TextBlock; text: string } | null {
  const index = content.findIndex(isTextBlock);
  if (index < 0) return null;
  const block = content[index];
  if (!isTextBlock(block)) return null;
  const text = stripLeadingSkillBlocks(block.text);
  if (text === block.text) return null;
  return { index, block, text: text ?? block.text };
}

function stripPersistedUserSkillBlocks(msg: PersistedMessage): PersistedMessage {
  if (msg.role !== "user") return msg;
  const stripped = strippedTextBlock(msg.content);
  if (!stripped) return msg;
  const content = msg.content.slice();
  content[stripped.index] = { ...stripped.block, text: stripped.text };
  return { ...msg, content };
}

export class Sessions {
  constructor(
    private broadcast: Broadcast = () => {},
    /** Wakes the node command dispatcher after a queued `session.setModel` commits (the periodic scan
     * recovers a missing wake). */
    private wakeNodeCommands?: () => void,
  ) {}


  get(sessionId: string): SessionDetailView | null {
    const row = getSession(sessionId);
    if (!row) return null;

    const messageCount = countMessages(sessionId);

    return {
      ...toSessionView(row),
      messageCount,
      runtimeType: row.agent_runtime_type,
      pendingOperation: row.agent_runtime_type === "pi" && nodeSessionActivity(row) === "idle"
        ? readPendingPiOperation(getDb(), sessionId)
        : null,
      state: {
        model: row.model_provider && row.model_id
          ? { provider: row.model_provider, id: row.model_id }
          : null,
        thinkingLevel: row.thinking_level,
      },
    };
  }

  async getContext(sessionId: string): Promise<SessionContextSnapshot | null> {
    const row = getSession(sessionId);
    if (!row) throw new SessionNotFoundError();
    if (!row.model_provider || !row.model_id || row.agent_runtime_type !== "pi") return null;

    const model = await findPiModel(row.model_provider, row.model_id);
    if (!model) return null;

    return buildSessionContextSnapshot(sessionId, {
      contextWindow: model.contextWindow,
      reserveTokens: DEFAULT_COMPACTION_SETTINGS.reserveTokens,
    });
  }

  getMessagePage(
    sessionId: string,
    limit: number,
    position: { beforeSeq?: number; afterSeq?: number } = {},
  ): SessionMessagePage | null {
    const row = getSession(sessionId);
    if (!row) return null;
    const page = loadMessagePage(sessionId, limit, position);
    return {
      ...page,
      items: page.items.map((item) => ({ ...item, message: stripPersistedUserSkillBlocks(item.message) })),
    };
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

  listByProject(projectId: number): SessionListView[] {
    return listSessions({ projectId, taskId: null }).map(toSessionListView);
  }

  listArchivedByProject(
    projectId: number,
    options: { limit?: number; offset?: number; search?: string } = {},
  ): SessionListView[] {
    return listSessions({
      projectId,
      includeTaskSessions: true,
      archived: "only",
      orderBy: "archived",
      ...options,
    }).map(toSessionListView);
  }

  listByTask(taskId: number, archived: "exclude" | "include" = "exclude"): SessionListView[] {
    return listSessions({ taskId, archived }).map(toSessionListView);
  }

  /** Sessions with a non-null activity_state, for initial activity snapshots. Activity is
   * authoritative from the node's durable lifecycle reports. */
  activeSessions() {
    return listSessionsWithActivity().map((row) => ({
      id: row.id,
      projectId: row.project_id,
      taskId: row.task_id,
      activityState: row.activity_state,
    }));
  }

  updateActivityState(sessionId: string, activityState: SessionRow["activity_state"]): void {
    const row = getSession(sessionId);
    if (!row) throw new SessionNotFoundError();

    const persistedActivityState = updateActivityState(sessionId, activityState);
    if (persistedActivityState === undefined) return;

    this.broadcast({
      type: "session_updated",
      sessionId,
      projectId: row.project_id,
    });
  }

  updateMetadata(sessionId: string, updates: SessionMetadataUpdates): SessionView {
    const row = getSession(sessionId);
    if (!row) throw new SessionNotFoundError();

    const updated = updateSessionMetadata(sessionId, updates);
    if (!updated) throw new SessionNotFoundError();

    this.broadcast({
      type: "session_updated",
      sessionId,
      projectId: row.project_id,
    });
    return toSessionView(updated);
  }

  /** Set an idle session's unread state without disturbing active work. */
  setUnread(sessionId: string, unread: boolean): void {
    const row = getSession(sessionId);
    if (!row) throw new SessionNotFoundError();
    if (unread && row.activity_state === "running") {
      throw new Error("Running sessions cannot be marked unread");
    }

    const activityState = unread ? "finished" : null;
    if (row.activity_state === activityState || (!unread && row.activity_state === "running")) return;
    this.updateActivityState(sessionId, activityState);
  }


  /** Every node, with whether the session can move there (eligible first). */
  moveTargets(sessionId: string): SessionMoveTarget[] {
    const row = getSession(sessionId);
    if (!row) throw new SessionNotFoundError();
    return sessionMoveTargets(row, sessionLocation(row));
  }

  /**
   * Moves the session to a node (`nodeId`): it is re-pointed at the target at once and hydrated there;
   * a previous owner is told nothing (see `requestSessionMove`). Queues the hydrate in
   * the node command outbox and returns the session's placement now (moving, or already there) without
   * waiting for the node; throws `SessionMoveConflict` while the session is busy or moving elsewhere.
   */
  move(sessionId: string, nodeId: string): SessionPlacementView {
    if (!requestSessionMove(sessionId, nodeId)) throw new SessionNotFoundError();
    this.wakeNodeCommands?.();
    const row = getSession(sessionId);
    if (!row) throw new SessionNotFoundError();
    this.broadcast({ type: "session_updated", sessionId, projectId: row.project_id });
    return toPlacementView(row);
  }

  /**
   * Change the AI model for a session.
   *
   * The model is validated against the server's catalog and stored on the row, then `session.setModel` is
   * queued in the node command outbox behind the session's earlier work and this returns without waiting;
   * the node applies it to Pi's lane asynchronously and a node rejection surfaces as a command failure. A
   * session at rest on the server is first queued for hydration onto its node (the lazy trigger), so the
   * change reaches Pi's lane there.
   * All session metadata changes broadcast a generic session_updated event so clients can reload the
   * canonical session state.
   */
  async setModel(params: SetSessionModelParams): Promise<SessionRow> {
    const sessionRow = getSession(params.sessionId);
    if (!sessionRow || (params.projectId !== undefined && sessionRow.project_id !== params.projectId)) {
      throw new SessionNotFoundError();
    }

    const nextRuntimeType = params.runtimeType ?? sessionRow.agent_runtime_type;
    if (nextRuntimeType !== "pi") {
      throw new Error("Canonical sessions use the pi runtime");
    }
    const isRuntimeSwitch = nextRuntimeType !== sessionRow.agent_runtime_type;
    const messageCount = countMessages(params.sessionId);

    if (isRuntimeSwitch && messageCount > 0) {
      throw new Error("Session runtime can only be changed before any messages are sent");
    }

    if (!await findPiModel(params.provider, params.modelId)) {
      throw new Error(`Model '${params.modelId}' not found for provider '${params.provider}'`);
    }

    const liveThinkingLevel = params.thinkingLevel ? parseThinkingLevel(params.thinkingLevel) : null;
    const thinkingLevel = liveThinkingLevel ?? sessionRow.thinking_level;

    const meta = {
      modelProvider: params.provider,
      modelId: params.modelId,
      thinkingLevel,
      agentRuntimeType: nextRuntimeType,
    };
    // The row and the queued command commit together; the node applies it in outbox order.
    getDb().transaction(() => {
      updateSessionMeta(params.sessionId, meta);
      queueHydrationForUse(params.sessionId, { seedModel: false });
      enqueueSetModel(params.sessionId, {
        provider: params.provider,
        modelId: params.modelId,
        ...(liveThinkingLevel ? { thinkingLevel: liveThinkingLevel } : {}),
      });
    })();
    this.wakeNodeCommands?.();

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

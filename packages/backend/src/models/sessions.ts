/**
 * Sessions
 *
 * Business logic for session read/write operations: session views read from the server's rows and
 * session storage (sessions run on nodes; there is no live runtime on the server), submitting work to a
 * session's node, metadata updates, model changes and moves, and their broadcasts.
 */

import {
  getSession,
  listSessions,
  listSessionsWithActivity,
  updateActivityState,
  updateSessionMeta,
  updateSessionMetadata,
  type SessionMetadataUpdates,
  type SessionRow,
} from "../session-store.js";
import {
  countMessages,
  loadMessagePage,
  type PersistedMessage,
  type SessionMessagePage,
  type ClientPromptContent,
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
import { readPendingPiOperation, type PendingPiOperation } from "../pi/pending-operation.js";
import { DEFAULT_COMPACTION_SETTINGS } from "@earendil-works/pi-agent-core";
import { findPiModel } from "../pi/model-catalog.js";
import { enqueueInput, enqueueSetModel } from "../nodes/node-command-store.js";
import { getNode, getSource, type Source } from "../node-store.js";
import type { NodeHub, RemoteNode } from "../state.js";
import { BUSY, RpcFailure, UNAUTHORIZED, type NodeError } from "@reins/node-protocol";
import { nodeRefusal } from "../errors.js";
import { requireSessionSource, resolveSource } from "./sources.js";
import { SessionModel } from "./session.js";
import { sessionActivity } from "./session-activity.js";
import { closeSessionOn, requestSessionMove, sessionMoveTargets, type SessionMoveTarget } from "../sessions/session-ownership.js";

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
 * Where the session runs: `nodeId`/`nodeName` are the node of its source, `available` whether that node
 * is connected (queued work waits while it is not), `path` its checkout's path on that node.
 */
export interface SessionPlacementView {
  available: boolean;
  nodeId: string;
  nodeName: string;
  path: string;
}

/** Work queued for a session's node in the command outbox: input (deduplicated by `clientId`) or a model
 * change. `sourceSessionId`: the session an addressed steer comes from. */
export type SessionSubmission =
  | { op: "prompt" | "steer"; content: ClientPromptContent; clientId: string; sourceSessionId?: string }
  | { op: "setModel"; provider: string; modelId: string; thinkingLevel?: string };

/** What session views and changes need from the node hub. */
export type SessionNodes = Pick<NodeHub, "get" | "wake">;

function toPlacementView(row: SessionRow, nodes: SessionNodes): SessionPlacementView {
  const source = getSource(row.source_id);
  const nodeId = source?.node_id ?? "unknown";
  return {
    available: nodes.get(nodeId).connected,
    nodeId,
    nodeName: getNode(nodeId)?.name ?? nodeId,
    path: source?.path ?? "",
  };
}

export interface SessionDetailView extends SessionView {
  /** A background session: the browser keeps it out of its session lists and activity badges. */
  background: boolean;
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

function toSessionView(row: SessionRow, nodes: SessionNodes): SessionView {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    parentSessionId: row.parent_session_id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    activityState: row.activity_state,
    placement: toPlacementView(row, nodes),
    pinnedAt: row.pinned_at,
    archivedAt: row.archived_at,
  };
}

function toSessionListView(row: SessionRow, nodes: SessionNodes): SessionListView {
  return {
    ...toSessionView(row, nodes),
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

/** Bound (ms) on the node answering an abort: it waits for the aborted run to go idle. */
const ABORT_TIMEOUT_MS = 30_000;
/** Bound (ms) on the node answering a resume: it may open the runtime first. Not on the resumed run. */
const RESUME_TIMEOUT_MS = 60_000;

/** A call to the session's node it did not carry out: its refusal (`error` is the node's NodeError), or
 * `unavailable` when it was not connected, did not answer in time or its link dropped. */
export class SessionCallFailed extends Error {
  constructor(readonly error: NodeError) {
    super(error.message);
    this.name = "SessionCallFailed";
  }
}

export class Sessions {
  constructor(
    /** Views report whether a session's node is connected; submissions and moves wake delivery. */
    private readonly nodes: SessionNodes,
    private broadcast: Broadcast = () => {},
  ) {}

  private listView = (row: SessionRow) => toSessionListView(row, this.nodes);

  /**
   * Queues `command` behind the session's earlier work and wakes delivery. Validates the session's current
   * source first (throws when it is unavailable, queueing nothing). The insert is synchronous, so a caller
   * may submit inside its own transaction; the wake is a microtask, so it runs once that transaction has
   * committed (after a rollback it finds nothing new). A replay of admitted input queues nothing. Work for
   * a node that is not connected waits in the outbox.
   */
  submit(sessionId: string, command: SessionSubmission): void {
    requireSessionSource(sessionId);
    if (command.op === "setModel") enqueueSetModel(sessionId, command);
    else enqueueInput(sessionId, command.op, command.content, command.clientId, command.sourceSessionId);
    queueMicrotask(() => void this.nodes.wake());
  }

  /**
   * Aborts the session's run on its current node at once (not ordered behind queued input) and returns
   * the node's answer: `{aborted: false}` when nothing is running. Throws `SessionCallFailed` when the
   * node refuses it or cannot be reached (never queued or retried); throws when the session or its
   * source is gone.
   */
  abort(sessionId: string): Promise<{ aborted: boolean }> {
    return this.callNode(sessionId, (node, session, source) =>
      node.request("session.abort", { sessionId, binding: session.binding(source) }, { timeoutMs: ABORT_TIMEOUT_MS }));
  }

  /**
   * Resumes the session's pending operation on its current node and returns the node's answer
   * (`{started}`). Resuming may open the runtime, so it carries the session context outbox commands do.
   * Fails like `abort`.
   */
  resume(sessionId: string): Promise<{ started: boolean }> {
    return this.callNode(sessionId, (node, session, source) =>
      node.request("session.resumePending", { sessionId, ...session.context(source) }, { timeoutMs: RESUME_TIMEOUT_MS }));
  }

  /** Calls the session's current node directly, turning a refusal or an unreachable node into `SessionCallFailed`. */
  private async callNode<T>(sessionId: string, call: (node: RemoteNode, session: SessionModel, source: Source) => Promise<T>): Promise<T> {
    const row = getSession(sessionId);
    if (!row) throw new Error(`Session not found: ${sessionId}`);
    const source = resolveSource(row.project_id, row.source_id);
    try {
      return await call(this.nodes.get(source.node_id), new SessionModel(row), source);
    } catch (error) {
      const refusal = nodeRefusal(error);
      if (refusal) throw new SessionCallFailed(refusal);
      // Not sent, refused before the node's handler ran (busy, stale epoch) or outcome unknown.
      if (error instanceof RpcFailure && (error.code === "unavailable" || error.code === BUSY || error.code === UNAUTHORIZED)) {
        throw new SessionCallFailed({ code: "unavailable", message: `Node unavailable: ${error.message}`, retryable: true });
      }
      throw error;
    }
  }

  /** Session `sessionId` as its node works with it; throws `SessionNotFoundError`. */
  get(sessionId: string): SessionModel {
    const row = getSession(sessionId);
    if (!row) throw new SessionNotFoundError(`Session not found: ${sessionId}`);
    return new SessionModel(row);
  }

  getDetail(sessionId: string): SessionDetailView | null {
    const row = getSession(sessionId);
    if (!row) return null;

    const messageCount = countMessages(sessionId);

    return {
      ...toSessionView(row, this.nodes),
      background: row.background === 1,
      messageCount,
      runtimeType: row.agent_runtime_type,
      pendingOperation: row.agent_runtime_type === "pi" && sessionActivity(row) === "idle"
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
    return listSessions({ projectId, taskId: null }).map(this.listView);
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
    }).map(this.listView);
  }

  listByTask(taskId: number, archived: "exclude" | "include" = "exclude"): SessionListView[] {
    return listSessions({ taskId, archived }).map(this.listView);
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
    return toSessionView(updated, this.nodes);
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


  /** A model change queued for the session failed on its node (`message`): tells every viewer, who also
   * refresh, since the row keeps the requested model until the next settlement reports the runtime's. */
  modelChangeFailed(sessionId: string, message: string): void {
    this.broadcast({ type: "error", sessionId, error: message });
    const row = getSession(sessionId);
    if (row) this.broadcast({ type: "session_updated", sessionId, projectId: row.project_id });
  }

  /** Every node, with whether the session can move there (eligible first). */
  moveTargets(sessionId: string): SessionMoveTarget[] {
    const row = getSession(sessionId);
    if (!row) throw new SessionNotFoundError();
    return sessionMoveTargets(row);
  }

  /**
   * Moves the idle session to a node (`nodeId`): it is re-pointed at the target's source at once (see
   * `requestSessionMove`), so its next command opens it there, and the node it left is told
   * `session.close` without waiting. Returns the session's placement; throws `SessionMoveConflict`
   * while the session is busy.
   */
  move(sessionId: string, nodeId: string): SessionPlacementView {
    const moved = requestSessionMove(sessionId, nodeId);
    if (!moved) throw new SessionNotFoundError();
    if (moved.previousNodeId) void closeSessionOn(this.nodes.get(moved.previousNodeId), sessionId);
    void this.nodes.wake();
    const row = getSession(sessionId);
    if (!row) throw new SessionNotFoundError();
    this.broadcast({ type: "session_updated", sessionId, projectId: row.project_id });
    return toPlacementView(row, this.nodes);
  }

  /**
   * Change the AI model for a session.
   *
   * The model is validated against the server's catalog and stored on the row, then `session.setModel` is
   * queued in the node command outbox behind the session's earlier work and this returns without waiting;
   * the node applies it to Pi's lane asynchronously and a node rejection surfaces as a command failure.
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
      this.submit(params.sessionId, {
        op: "setModel",
        provider: params.provider,
        modelId: params.modelId,
        ...(liveThinkingLevel ? { thinkingLevel: liveThinkingLevel } : {}),
      });
    })();

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

/**
 * Sessions
 *
 * Business logic for session read/write operations: session views read from the server's rows and
 * session storage, submitting work to a session's live runtime on the server (ADR-029), abort and resume,
 * metadata updates, model changes and moves, and their broadcasts.
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
import { getNode, getSource } from "../node-store.js";
import type { NodeHub, ServerState } from "../state.js";
import { MAX_PROMPT_CONTENT_BYTES, promptContentBytes } from "@reins/node-protocol";
import { resolveSource } from "./sources.js";
import { SessionModel } from "./session.js";
import { sessionActivity } from "./session-activity.js";
import { requestSessionMove, sessionMoveTargets, type SessionMoveTarget } from "../sessions/session-ownership.js";
import { closeSessionRuntime, liveSessionRuntime, sessionProcess, withSessionRuntime } from "../session-runtime/live.js";

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

const mib = (bytes: number) => bytes / (1024 * 1024);

/** Prompt or steer content larger than a submission may carry (`MAX_PROMPT_CONTENT_BYTES`). */
export class PromptTooLargeError extends Error {
  constructor(bytes: number) {
    super(`Prompt too large: ${mib(bytes).toFixed(1)} MiB of content; the most a prompt can carry is ${mib(MAX_PROMPT_CONTENT_BYTES)} MiB`);
    this.name = "PromptTooLargeError";
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
 * is connected (a run's checkout and tool calls wait while it is not), `removed` whether it was removed (the session takes no
 * work until it is moved), `path` its checkout's path on that node.
 */
export interface SessionPlacementView {
  available: boolean;
  removed: boolean;
  nodeId: string;
  nodeName: string;
  path: string;
}

/** Input submitted to a session: admitted by Pi under `clientId` (its `reinsId`, so a replay converges).
 * `sourceSessionId`: the session an addressed steer comes from. */
export interface SessionSubmission {
  op: "prompt" | "steer";
  content: ClientPromptContent;
  clientId: string;
  sourceSessionId?: string;
}

/** What session work needs of a handler load: its node hub (whether a session's node is connected), and
 * the process's sessions and browser clients (the live runtimes). */
export type SessionServices = Pick<ServerState, "nodes" | "sessions" | "clients">;

function toPlacementView(row: SessionRow, nodes: Pick<NodeHub, "get">): SessionPlacementView {
  const source = getSource(row.source_id);
  const nodeId = source?.node_id ?? "unknown";
  const node = getNode(nodeId);
  return {
    available: nodes.get(nodeId).connected,
    removed: node?.removedAt != null,
    nodeId,
    nodeName: node?.name ?? nodeId,
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

function toSessionView(row: SessionRow, nodes: Pick<NodeHub, "get">): SessionView {
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

function toSessionListView(row: SessionRow, nodes: Pick<NodeHub, "get">): SessionListView {
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

export class Sessions {
  constructor(
    /** Views report whether a session's node is connected; work goes to the process's live runtimes. */
    private readonly state: SessionServices,
    private readonly broadcast: Broadcast,
  ) {}

  private get nodes(): Pick<NodeHub, "get"> { return this.state.nodes; }

  private listView = (row: SessionRow) => toSessionListView(row, this.nodes);

  /**
   * Submits input to the session's live runtime (opened from its rows if it has none) and resolves once
   * Pi committed it under `clientId`: a prompt's run then proceeds in the background, a steer is queued on
   * the lane. A session's submissions apply one at a time in arrival order (its chain is entered as this is
   * called). A replay under the same clientId converges on the admitted input and resolves again. A node
   * that is offline does not hold admission up (a run waits for it at its first request), except to
   * expand a skill only the checkout has. Throws `SessionNotFoundError`, `PromptTooLargeError` and
   * `SessionNodeRemovedError` before anything is submitted, and rejects with what admission throws.
   */
  async submit(sessionId: string, input: SessionSubmission): Promise<void> {
    const session = this.get(sessionId);
    session.assertRunnable(resolveSource(session.projectId, session.row.source_id));
    const bytes = promptContentBytes(input.content);
    if (bytes > MAX_PROMPT_CONTENT_BYTES) throw new PromptTooLargeError(bytes);
    const options = { reinsId: input.clientId, ...(input.sourceSessionId ? { metadata: { sourceSessionId: input.sourceSessionId } } : {}) };
    await this.inOrder(sessionId, () => withSessionRuntime(sessionProcess(this.state), sessionId, async runtime => {
      if (input.op === "prompt") await runtime.prompt(input.content, options);
      else await runtime.steer(input.content, options);
    }));
  }

  /** Runs `work` once the session's earlier submissions are done (`ProcessSessions.submissions`). Enters
   * the chain synchronously, so calls apply in the order they were made. */
  private inOrder<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const chains = this.state.sessions.submissions;
    const run = (chains.get(sessionId) ?? Promise.resolve()).then(work);
    const tail = run.then(() => undefined, () => undefined);
    chains.set(sessionId, tail);
    void tail.then(() => { if (chains.get(sessionId) === tail) chains.delete(sessionId); });
    return run;
  }

  /**
   * Aborts the session's run in its live runtime at once (not ordered behind submissions), waiting for it
   * to stop: `{aborted: false}` when it has no live runtime or nothing is running (none is opened to
   * abort). Throws `SessionNotFoundError`.
   */
  async abort(sessionId: string): Promise<{ aborted: boolean }> {
    this.get(sessionId);
    const runtime = await liveSessionRuntime(sessionProcess(this.state), sessionId);
    if (!runtime) return { aborted: false };
    const busy = runtime.isStreaming();
    await runtime.abort();
    return { aborted: busy };
  }

  /**
   * Drives the operation an interruption left pending in the session's storage, in its live runtime
   * (opened if needed): `{started: true}` while it is being driven (also when an input joined it first),
   * `{started: false}` when there is nothing to resume. Throws `SessionNotFoundError`,
   * `SessionNodeRemovedError` and what opening the runtime throws.
   */
  async resume(sessionId: string): Promise<{ started: boolean }> {
    const session = this.get(sessionId);
    session.assertRunnable(resolveSource(session.projectId, session.row.source_id));
    return { started: await withSessionRuntime(sessionProcess(this.state), sessionId, runtime => runtime.resumePendingOperation()) };
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
      pendingOperation: row.agent_runtime_type === "pi" && sessionActivity(row, this.state.sessions) === "idle"
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
   * authoritative from the runtimes' durable lifecycle reports. */
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


  /** Every node, with whether the session can move there (eligible first). */
  moveTargets(sessionId: string): SessionMoveTarget[] {
    const row = getSession(sessionId);
    if (!row) throw new SessionNotFoundError();
    return sessionMoveTargets(row);
  }

  /**
   * Moves the idle session to a node (`nodeId`): it is re-pointed at the target's source at once (see
   * `requestSessionMove`), and its live runtime, bound to the source it left, is closed, so its next
   * submission opens it there. Returns the session's placement; throws `SessionMoveConflict` while the
   * session is busy.
   */
  async move(sessionId: string, nodeId: string): Promise<SessionPlacementView> {
    const moved = requestSessionMove(sessionId, nodeId, this.state.sessions);
    if (!moved) throw new SessionNotFoundError();
    if (moved.previousNodeId) await closeSessionRuntime(sessionProcess(this.state), sessionId);
    const row = getSession(sessionId);
    if (!row) throw new SessionNotFoundError();
    this.broadcast({ type: "session_updated", sessionId, projectId: row.project_id });
    return toPlacementView(row, this.nodes);
  }

  /**
   * Change the AI model for a session.
   *
   * In order with the session's submissions, from the moment it is called: the model is validated against
   * the server's catalog, then set through the session's live runtime (opened with the new model if
   * needed, so a lane Pi has not created yet, or one whose model is gone, is repaired), and only then
   * stored on the row. A failure is
   * this call's: the row keeps its model. Omitting the thinking level keeps Pi's. All session metadata
   * changes broadcast a generic session_updated event so clients can reload the canonical session state.
   */
  setModel(params: SetSessionModelParams): Promise<SessionRow> {
    // In order with the session's submissions from the moment it is called: validation waits its turn.
    return this.inOrder(params.sessionId, async () => {
      const sessionRow = getSession(params.sessionId);
      if (!sessionRow || (params.projectId !== undefined && sessionRow.project_id !== params.projectId)) {
        throw new SessionNotFoundError();
      }

      const nextRuntimeType = params.runtimeType ?? sessionRow.agent_runtime_type;
      if (nextRuntimeType !== "pi") {
        throw new Error("Canonical sessions use the pi runtime");
      }
      const isRuntimeSwitch = nextRuntimeType !== sessionRow.agent_runtime_type;
      if (isRuntimeSwitch && countMessages(params.sessionId) > 0) {
        throw new Error("Session runtime can only be changed before any messages are sent");
      }

      if (!await findPiModel(params.provider, params.modelId)) {
        throw new Error(`Model '${params.modelId}' not found for provider '${params.provider}'`);
      }

      const liveThinkingLevel = params.thinkingLevel ? parseThinkingLevel(params.thinkingLevel) : null;
      const model = { provider: params.provider, modelId: params.modelId, ...(liveThinkingLevel ? { thinkingLevel: liveThinkingLevel } : {}) };
      await withSessionRuntime(sessionProcess(this.state), params.sessionId, runtime => runtime.setModel(model), { model });

      updateSessionMeta(params.sessionId, {
        modelProvider: params.provider,
        modelId: params.modelId,
        thinkingLevel: liveThinkingLevel ?? sessionRow.thinking_level,
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
    });
  }
}

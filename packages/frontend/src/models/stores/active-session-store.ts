/**
 * Active Session Store
 *
 * Tracks which session is currently being viewed. Session metadata and the
 * derived project ID live in SessionCache; conversation state lives in ConversationsStore.
 * Does NOT hold task or session lists — that data lives in ProjectStore via
 * ProjectsStore.
 *
 * Components subscribe via `subscribe()` and read public state directly.
 * Mutations go through action methods which call the backend API.
 */

import type { SessionModelUpdate } from "@backend/routes/sessions.js";
import type { SessionDetailView as SessionData } from "@backend/models/sessions.js";
import type { SessionAttachmentInfo as AttachmentInfo } from "@backend/session-attachments-store.js";
import type { SessionContextSnapshot } from "@backend/models/session-context.js";
import type { ModelSetting } from "@backend/settings-store.js";
import type { ClientPromptContent } from "../chat-content.js";
import { ReinsHttpError } from "@reins/client";
import { api } from "../api.js";
import { isThinkingLevel } from "../settings.js";
import type { IAppClient } from "../ws-client.js";
import { SessionOperations, type SubmissionOp } from "../session-operations.js";
import { SessionCache } from "./session-cache.js";
import {
  ConversationsStore,
  type ConversationView,
  type LiveConversationEntry,
} from "./conversations-store.js";

export interface SessionAttachmentUpload {
  file: File;
  mimeType: string;
  filename: string;
}

export type ActiveSessionStoreListener = () => void;

/** Uploads images to a session, for a message that refers to them. */
export async function uploadSessionAttachments(sessionId: string, attachments: readonly SessionAttachmentUpload[]): Promise<AttachmentInfo[]> {
  if (attachments.length === 0) return [];
  const form = new FormData();
  for (const attachment of attachments) {
    const uploadFile = attachment.file.type === attachment.mimeType
      ? attachment.file
      : new Blob([attachment.file], { type: attachment.mimeType });
    form.append("files", uploadFile, attachment.filename);
  }
  const body = await api.sessions.addAttachments(sessionId, form);
  return body.attachments;
}

const CONTEXT_POLL_INTERVAL_MS = 10_000;

function blankSessionData(sessionId = ""): SessionData {
  return {
    id: sessionId,
    projectId: 0,
    taskId: null,
    parentSessionId: null,
    name: null,
    createdAt: "",
    updatedAt: "",
    runtimeType: undefined,
    activityState: null,
    pinnedAt: null,
    archivedAt: null,
    background: false,
    placement: { available: true, removed: false, nodeId: "", nodeName: "", path: "" },
    pendingOperation: null,
    messageCount: 0,
    state: {
      model: null,
      thinkingLevel: "high",
    },
  };
}

export class ActiveSessionStore {
  // ---- Public reactive state ------------------------------------------------

  readonly sessionId: string;

  get projectId(): number | null {
    return this.sessionData.projectId || null;
  }

  get sessionData(): SessionData {
    return this._sessionCache.getDetail(this.sessionId) ?? blankSessionData(this.sessionId);
  }

  /** The session's model, as a model setting for the picker; its runtime is empty when the session has none recorded. */
  get model(): ModelSetting | null {
    const { state, runtimeType } = this.sessionData;
    if (!state.model) return null;
    return {
      provider: state.model.provider,
      modelId: state.model.id,
      runtimeType: runtimeType ?? "",
      thinkingLevel: isThinkingLevel(state.thinkingLevel) ? state.thinkingLevel : "high",
    };
  }

  get conversation(): ConversationView {
    return this._conversationsStore.get(this.sessionId);
  }

  get contextSnapshot(): SessionContextSnapshot | null {
    return this._contextSnapshot;
  }

  // ---- Private state --------------------------------------------------------

  private _listeners = new Set<ActiveSessionStoreListener>();
  private _unsubscribeSession: (() => void) | null = null;
  private _unsubscribeConversation: (() => void) | null = null;
  private _unsubscribeEvents: (() => void) | null = null;
  private _contextSnapshot: SessionContextSnapshot | null = null;
  private _contextRefreshGeneration = 0;
  private _contextRefreshScheduled = false;
  private _contextPollTimer: ReturnType<typeof setInterval> | null = null;
  private _lastKnownModelKey = "";
  private _markReadInFlight: string | null = null;
  private _activityMutationQueue: Promise<unknown> = Promise.resolve();
  private _lastKnownRunning = false;
  private _observed = false;
  private _disposed = false;

  constructor(
    sessionId: string,
    private _client: IAppClient | null = null,
    private _sessionCache: SessionCache = new SessionCache(),
    private _conversationsStore: ConversationsStore = new ConversationsStore(),
    private _operations: SessionOperations = new SessionOperations({ conversations: _conversationsStore }),
  ) {
    this.sessionId = sessionId;
    this._unsubscribeSession = this._sessionCache.subscribe(sessionId, () => { void this.handleSessionCacheUpdate(); });
    this._unsubscribeConversation = this._conversationsStore.subscribe(sessionId, () => {
      this.notify();
    });
    this._unsubscribeEvents = this._client?.subscribe({
      event: (message) => {
        if (message.sessionId !== this.sessionId) return;
        if (
          message.event.type === "entry_added"
          || message.event.type === "compaction_end"
        ) this.scheduleContextRefresh();
      },
    }) ?? null;
  }

  // ---- Subscription ---------------------------------------------------------

  subscribe(fn: ActiveSessionStoreListener): () => void {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  private notify() {
    if (this._disposed) return;
    for (const fn of this._listeners) fn();
  }

  dispose(): void {
    this._disposed = true;
    this.stopContextPolling();
    this._unsubscribeSession?.();
    this._unsubscribeSession = null;
    this._unsubscribeConversation?.();
    this._unsubscribeConversation = null;
    this._unsubscribeEvents?.();
    this._unsubscribeEvents = null;
    this._listeners.clear();
  }

  // ---- Initialization -------------------------------------------------------

  /** Initialize the route-scoped session facade and refresh server-backed state. */
  async initialize(): Promise<void> {
    if (this._disposed) return;

    const cachedSession = this._sessionCache.getDetail(this.sessionId);
    if (cachedSession) {
      this._lastKnownRunning = cachedSession.activityState === "running";
      this._lastKnownModelKey = this.modelKey(cachedSession);
      if (!this._lastKnownRunning) {
        this._conversationsStore.clearCompactingState(this.sessionId);
      }
      this.notify();
    } else {
      this.notify();
    }

    await this.refreshFromServer();
    if (this._observed) void this.setUnread(false);
  }

  /** Refresh canonical metadata and persisted messages for the active session. */
  async refreshFromServer(): Promise<void> {
    if (this._disposed) return;
    await Promise.allSettled([
      this._sessionCache.fetchDetail(this.sessionId),
      this._conversationsStore.syncMessages(this.sessionId),
      this.refreshContext(),
    ]);
  }

  // ---- Actions --------------------------------------------------------------

  async refreshContext(): Promise<boolean> {
    const generation = ++this._contextRefreshGeneration;
    try {
      const context = await api.sessions.context(this.sessionId);
      if (this._disposed || generation !== this._contextRefreshGeneration) return false;
      this._contextSnapshot = context;
      this.notify();
      return true;
    } catch {
      return false;
    }
  }

  /** Report whether this session's conversation is meaningfully visible. */
  setObserved(observed: boolean): void {
    if (this._disposed || this._observed === observed) return;
    this._observed = observed;
    this.syncContextPolling();
    if (observed) void this.setUnread(false);
  }

  prompt(message: ClientPromptContent): LiveConversationEntry | null {
    const entry = this.submit("prompt", message);
    if (entry) this.setOptimisticRunning();
    return entry;
  }

  steer(message: ClientPromptContent): LiveConversationEntry | null {
    return this.submit("steer", message);
  }

  private submit(op: SubmissionOp, message: ClientPromptContent): LiveConversationEntry | null {
    if (this._disposed) return null;
    const submission = this._operations.submit(this.sessionId, op, message);
    if (!submission) return null;
    // The conversation shows a refusal. A refused prompt has no run to end the activity shown for it.
    submission.admitted.catch(() => { void this._sessionCache.fetchDetail(this.sessionId); });
    return submission.entry;
  }

  async resumePendingOperation(): Promise<boolean> {
    if (this._disposed) return false;
    await api.sessions.resume(this.sessionId);
    await this._sessionCache.fetchDetail(this.sessionId);
    return true;
  }

  clearConversationError(): void {
    if (this._disposed) return;
    this._conversationsStore.clearError(this.sessionId);
  }

  abort(): boolean {
    if (this._disposed) return false;
    const sessionId = this.sessionId;
    this._operations.abort(sessionId).catch((error: unknown) => {
      this._conversationsStore.setError(sessionId, `abort failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    return true;
  }

  async uploadAttachments(attachments: readonly SessionAttachmentUpload[]): Promise<AttachmentInfo[]> {
    if (attachments.length === 0) return [];
    if (this._disposed) throw new Error("No active session");
    return uploadSessionAttachments(this.sessionId, attachments);
  }

  /** React to canonical metadata changes for the active session. */
  private async handleSessionCacheUpdate() {
    if (this._disposed) return;

    const data = this._sessionCache.getDetail(this.sessionId);
    if (!data) return;

    const wasRunning = this._lastKnownRunning;
    const isRunning = data.activityState === "running";
    const modelKey = this.modelKey(data);
    const modelChanged = this._lastKnownModelKey !== "" && modelKey !== this._lastKnownModelKey;
    this._lastKnownModelKey = modelKey;
    if (modelChanged) void this.refreshContext();
    const conversation = this._conversationsStore.get(this.sessionId);
    const hadStreamingState = conversation.streamingMessages.length > 0 || conversation.isCompacting;
    this._lastKnownRunning = isRunning;
    this.syncContextPolling();
    if (!isRunning) {
      // Terminal metadata can recover a missed compaction_end, but cannot
      // identify which received assistant or live entries persistence contains.
      if (conversation.isCompacting) {
        this._conversationsStore.clearCompactingState(this.sessionId);
        this.scheduleContextRefresh();
      }
    }
    // Canonical entries remove identity-linked overlays; terminal metadata
    // triggers a page sync to recover any durable events missed in transit.
    this.notify();
    if (wasRunning && data.activityState === "finished" && this._observed) {
      void this.setUnread(false);
    }

    // If running activity just ended, or the first observed metadata is
    // terminal while snapshots exist, pick up canonical records. The merge
    // removes only matching durable identities and preserves unmatched work.
    if (!isRunning && (wasRunning || hadStreamingState)) {
      await this._conversationsStore.syncMessages(this.sessionId);
    }
  }

  /** Set unread state for the active session. */
  async setUnread(unread: boolean): Promise<{ ok: true } | { error: string }> {
    if (this._disposed) return { error: "No active session" };
    const sessionId = this.sessionId;
    const projectId = this.projectId;
    if (projectId == null) return { error: "No active session" };
    if (this.sessionData.activityState === "running") {
      return unread ? { error: "Running sessions cannot be marked unread" } : { ok: true };
    }

    const previousState = this.sessionData.activityState;
    const nextState = unread ? "finished" : null;
    if (previousState === nextState) return { ok: true };
    if (!unread && this._markReadInFlight === sessionId) return { ok: true };

    if (!unread) this._markReadInFlight = sessionId;
    this._sessionCache.set(sessionId, { activityState: nextState });

    try {
      const request = this._activityMutationQueue.then(() => (
        api.sessions.setActivity(sessionId, { unread })
      ));
      this._activityMutationQueue = request.catch(() => undefined);
      await request;
      if (this._disposed) return { error: "No active session" };
      return { ok: true };
    } catch (error) {
      if (error instanceof ReinsHttpError) {
        if (!this._disposed && this.sessionData.activityState === nextState) {
          this._sessionCache.set(sessionId, { projectId, activityState: previousState });
        }
        return { error: `HTTP ${error.status}` };
      }
      if (!this._disposed && this.sessionData.activityState === nextState) {
        this._sessionCache.set(sessionId, { projectId, activityState: previousState });
      }
      return { error: "Network error" };
    } finally {
      if (!unread && this._markReadInFlight === sessionId) {
        this._markReadInFlight = null;
      }
    }
  }

  async updateSessionModel(update: SessionModelUpdate): Promise<{ ok: true } | { error: string }> {
    if (this._disposed) return { error: "No active session" };

    try {
      const session = await this._operations.setModel(this.sessionId, update);
      this._sessionCache.set(session.id, session);
      return { ok: true };
    } catch (error) {
      return { error: error instanceof ReinsHttpError ? error.message : "Network error" };
    }
  }

  private modelKey(data: SessionData): string {
    const model = data.state.model;
    return model ? `${model.provider}\u0000${model.id}` : "";
  }

  private scheduleContextRefresh(): void {
    if (this._disposed || this._contextRefreshScheduled) return;
    this._contextRefreshScheduled = true;
    queueMicrotask(() => {
      this._contextRefreshScheduled = false;
      if (!this._disposed) void this.refreshContext();
    });
  }

  private syncContextPolling(): void {
    const shouldPoll = this._observed && this.sessionData.activityState === "running";
    if (shouldPoll && this._contextPollTimer === null) {
      this._contextPollTimer = setInterval(() => void this.refreshContext(), CONTEXT_POLL_INTERVAL_MS);
    } else if (!shouldPoll) {
      this.stopContextPolling();
    }
  }

  private stopContextPolling(): void {
    if (this._contextPollTimer === null) return;
    clearInterval(this._contextPollTimer);
    this._contextPollTimer = null;
  }

  private setOptimisticRunning(): void {
    const sessionId = this.sessionId;
    if (!this._sessionCache.getDetail(sessionId)) return;
    this._sessionCache.set(sessionId, { activityState: "running" });
  }

  async loadEarlierMessages(): Promise<boolean> {
    if (this._disposed) return false;
    return this._conversationsStore.loadEarlierMessages(this.sessionId);
  }
}

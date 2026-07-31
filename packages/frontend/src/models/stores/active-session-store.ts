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

import type { AttachmentInfo, ClientPromptContent } from "../chat-content.js";
import type { IAppClient, SessionData } from "../ws-client.js";
import { SessionCache } from "./session-cache.js";
import {
  ConversationsStore,
  type ConversationView,
  type LiveConversationEntry,
} from "./conversations-store.js";

export interface SessionModelUpdate {
  runtimeType?: string;
  provider: string;
  modelId: string;
  thinkingLevel: string;
}

export interface SessionAttachmentUpload {
  file: File;
  mimeType: string;
  filename: string;
}

export type ActiveSessionStoreListener = () => void;

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

  get conversation(): ConversationView {
    return this._conversationsStore.get(this.sessionId);
  }

  // ---- Private state --------------------------------------------------------

  private _listeners = new Set<ActiveSessionStoreListener>();
  private _unsubscribeSession: (() => void) | null = null;
  private _unsubscribeConversation: (() => void) | null = null;
  private _markViewedInFlight: string | null = null;
  private _lastKnownRunning = false;
  private _disposed = false;

  constructor(
    sessionId: string,
    private _client: IAppClient | null = null,
    private _sessionCache: SessionCache = new SessionCache(),
    private _conversationsStore: ConversationsStore = new ConversationsStore(),
  ) {
    this.sessionId = sessionId;
    this._unsubscribeSession = this._sessionCache.subscribe(sessionId, () => { void this.handleSessionCacheUpdate(); });
    this._unsubscribeConversation = this._conversationsStore.subscribe(sessionId, () => {
      this.notify();
    });
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
    this._unsubscribeSession?.();
    this._unsubscribeSession = null;
    this._unsubscribeConversation?.();
    this._unsubscribeConversation = null;
    this._listeners.clear();
  }

  // ---- Initialization -------------------------------------------------------

  /** Initialize the route-scoped session facade and refresh server-backed state. */
  async initialize(): Promise<void> {
    if (this._disposed) return;

    const cachedSession = this._sessionCache.getDetail(this.sessionId);
    if (cachedSession) {
      this._lastKnownRunning = cachedSession.activityState === "running";
      if (!this._lastKnownRunning) {
        this._conversationsStore.clearCompactingState(this.sessionId);
      }
      this.notify();
      if (cachedSession.activityState === "finished") {
        void this.markViewed();
      }
    } else {
      this.notify();
    }

    await this.refreshFromServer();
  }

  /** Refresh canonical metadata and persisted messages for the active session. */
  async refreshFromServer(): Promise<void> {
    if (this._disposed) return;
    await Promise.allSettled([
      this._sessionCache.fetchDetail(this.sessionId),
      this._conversationsStore.syncMessages(this.sessionId),
    ]);
  }

  // ---- Actions --------------------------------------------------------------

  prompt(message: ClientPromptContent): LiveConversationEntry | null {
    if (this._disposed || !this._client) return null;
    this._client.prompt(this.sessionId, message);
    const entry = this._conversationsStore.addOptimisticUserMessage(this.sessionId, message);
    this.setOptimisticRunning();
    return entry;
  }

  steer(message: ClientPromptContent): LiveConversationEntry | null {
    if (this._disposed || !this._client) return null;
    this._client.steer(this.sessionId, message);
    return this._conversationsStore.addOptimisticUserMessage(this.sessionId, message);
  }

  clearConversationError(): void {
    if (this._disposed) return;
    this._conversationsStore.clearError(this.sessionId);
  }

  abort(): boolean {
    if (this._disposed || !this._client) return false;
    this._client.abort(this.sessionId);
    return true;
  }

  async uploadAttachments(attachments: readonly SessionAttachmentUpload[]): Promise<AttachmentInfo[]> {
    if (attachments.length === 0) return [];
    if (this._disposed) throw new Error("No active session");

    const form = new FormData();
    for (const attachment of attachments) {
      const uploadFile = attachment.file.type === attachment.mimeType
        ? attachment.file
        : new Blob([attachment.file], { type: attachment.mimeType });
      form.append("files", uploadFile, attachment.filename);
    }

    const response = await fetch(`/api/sessions/${encodeURIComponent(this.sessionId)}/attachments`, {
      method: "POST",
      body: form,
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || "Failed to upload attachments");
    }

    const body: { attachments?: AttachmentInfo[] } = await response.json();
    return body.attachments ?? [];
  }

  /** React to canonical metadata changes for the active session. */
  private async handleSessionCacheUpdate() {
    if (this._disposed) return;

    const data = this._sessionCache.getDetail(this.sessionId);
    if (!data) return;

    const wasRunning = this._lastKnownRunning;
    const isRunning = data.activityState === "running";
    const conversation = this._conversationsStore.get(this.sessionId);
    const hadStreamingState = conversation.streamingAssistants.length > 0 || conversation.isCompacting;
    this._lastKnownRunning = isRunning;
    if (!isRunning) {
      // Terminal metadata can recover a missed compaction_end, but cannot
      // identify which received assistant or live entries persistence contains.
      this._conversationsStore.clearCompactingState(this.sessionId);
    }
    // Received assistant snapshots remain visible until agent_end promotes
    // them or persisted assistant timestamps reconcile matching snapshots.
    this.notify();
    if (data.activityState === "finished") {
      void this.markViewed();
    }

    // If running activity just ended, or the first observed metadata is
    // terminal while snapshots exist, pick up canonical records. The merge
    // removes only matching assistant timestamps and preserves unmatched work.
    if (!isRunning && (wasRunning || hadStreamingState)) {
      await this._conversationsStore.syncMessages(this.sessionId);
    }
  }

  /**
   * Mark the displayed session's finished activity as viewed. Activity state
   * itself lives in SessionCache, so clearing it there updates project/sidebar
   * selectors immediately while the server request reconciles other clients.
   */
  async markViewed(): Promise<void> {
    if (this._disposed) return;
    const sessionId = this.sessionId;
    const projectId = this.projectId;
    if (projectId == null) return;
    if (this.sessionData.activityState !== "finished") return;
    if (this._markViewedInFlight === sessionId) return;

    this._markViewedInFlight = sessionId;
    this._sessionCache.set(sessionId, { activityState: null });

    try {
      const resp = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/activity`, {
        method: "PATCH",
      });
      if (this._disposed) return;
      if (!resp.ok) {
        this._sessionCache.set(sessionId, { projectId, activityState: "finished" });
      }
    } catch {
      if (this._disposed) return;
      this._sessionCache.set(sessionId, { projectId, activityState: "finished" });
    } finally {
      if (this._markViewedInFlight === sessionId) {
        this._markViewedInFlight = null;
      }
    }
  }

  async updateSessionModel(update: SessionModelUpdate): Promise<{ ok: true } | { error: string }> {
    if (this._disposed) return { error: "No active session" };

    try {
      const resp = await fetch(`/api/sessions/${encodeURIComponent(this.sessionId)}/model`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(update),
      });

      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        return { error: body.error || "Failed to update session model" };
      }

      await this._sessionCache.fetchDetail(this.sessionId);
      return { ok: true };
    } catch {
      return { error: "Network error" };
    }
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

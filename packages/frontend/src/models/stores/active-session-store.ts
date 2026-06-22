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

import type { AgentMessage } from "../chat-state.js";
import type { AttachmentInfo, ClientPromptContent } from "../chat-content.js";
import type { IAppClient, SessionData } from "../ws-client.js";
import { SessionCache } from "./session-cache.js";
import { ConversationsStore, type SessionConversationState } from "./conversations-store.js";

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

  get conversation(): SessionConversationState {
    return this._conversationsStore.get(this.sessionId);
  }

  // ---- Private state --------------------------------------------------------

  private _listeners = new Set<ActiveSessionStoreListener>();
  private _unsubscribeSession: (() => void) | null = null;
  private _unsubscribeConversation: (() => void) | null = null;
  private _fetchId = 0; // guards against stale message fetches
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
    this._fetchId++;
    this._unsubscribeSession?.();
    this._unsubscribeSession = null;
    this._unsubscribeConversation?.();
    this._unsubscribeConversation = null;
    this._listeners.clear();
  }

  // ---- Initialization -------------------------------------------------------

  /**
   * Initialize the route-scoped session facade. Metadata is read from
   * SessionCache; callers are responsible for fetching/populating that cache.
   */
  async initialize(): Promise<void> {
    if (this._disposed) return;

    const fetchId = ++this._fetchId;
    const cachedSession = this._sessionCache.getDetail(this.sessionId);
    if (cachedSession) {
      this._lastKnownRunning = cachedSession.activityState === "running";
      if (!this._lastKnownRunning) {
        this._conversationsStore.clearStreamingState(this.sessionId);
      }
      this.notify();
      if (cachedSession.activityState === "finished") {
        void this.markViewed();
      }
    } else {
      this.notify();
    }

    await this.fetchSessionMessages(this.sessionId, fetchId);
  }

  // ---- Actions --------------------------------------------------------------

  prompt(message: ClientPromptContent): boolean {
    if (this._disposed || !this._client) return false;
    this._client.prompt(this.sessionId, message);
    this.setOptimisticRunning();
    return true;
  }

  steer(message: ClientPromptContent): boolean {
    if (this._disposed || !this._client) return false;
    this._client.steer(this.sessionId, message);
    return true;
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
    this._lastKnownRunning = isRunning;
    if (wasRunning && !isRunning) {
      this._conversationsStore.clearStreamingState(this.sessionId);
    }
    this.notify();
    if (data.activityState === "finished") {
      void this.markViewed();
    }

    // If running activity just ended (missed agent_end during disconnect/navigation),
    // also refresh messages to pick up the completed turn's results.
    if (wasRunning && !isRunning) {
      await this.fetchSessionMessages(this.sessionId);
    }
  }

  /** Load persisted messages for the active session. */
  async refreshMessages() {
    if (!this._disposed) {
      await this.fetchSessionMessages(this.sessionId);
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

  // ---- Internal fetching ----------------------------------------------------

  private setOptimisticRunning(): void {
    const sessionId = this.sessionId;
    if (!this._sessionCache.getDetail(sessionId)) return;
    this._sessionCache.set(sessionId, { activityState: "running" });
  }

  private async fetchSessionMessages(sessionId: string, fetchId = this._fetchId): Promise<boolean> {
    try {
      const resp = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages`);
      if (!resp.ok) return false;
      if (fetchId !== this._fetchId) return false; // stale
      const data: AgentMessage[] = await resp.json();
      if (this._disposed || fetchId !== this._fetchId) return false;
      this._conversationsStore.setPersistedMessages(sessionId, data);
      return true;
    } catch {
      return false;
    }
  }
}

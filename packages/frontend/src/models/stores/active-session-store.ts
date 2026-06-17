/**
 * Active Session Store
 *
 * Tracks which session is currently being viewed: the session ID, its full
 * data, and the derived project ID (for diff context). Does NOT hold task
 * or session lists — that data lives in ProjectStore via ProjectsStore.
 *
 * Components subscribe via `subscribe()` and read public state directly.
 * Mutations go through action methods which call the backend API.
 */

import type { AgentMessage } from "../chat-state.js";
import type { AttachmentInfo, ClientPromptContent } from "../chat-content.js";
import type { EventListener, IAppClient, SessionData } from "../ws-client.js";
import { SessionCache } from "./session-cache.js";

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
      isStreaming: false,
      messageCount: 0,
    },
  };
}

export class ActiveSessionStore {
  // ---- Public reactive state ------------------------------------------------

  projectId: number | null = null;
  sessionId = "";
  sessionData: SessionData = blankSessionData();
  sessionMessages: AgentMessage[] = [];

  // ---- Private state --------------------------------------------------------

  private _listeners = new Set<ActiveSessionStoreListener>();
  private _unsubscribeSession: (() => void) | null = null;
  private _fetchId = 0; // guards against stale message fetches

  constructor(
    private _client: IAppClient | null = null,
    private _sessionCache: SessionCache = new SessionCache(),
  ) {}

  // ---- Subscription ---------------------------------------------------------

  subscribe(fn: ActiveSessionStoreListener): () => void {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  private notify() {
    for (const fn of this._listeners) fn();
  }

  dispose(): void {
    this._unsubscribeSession?.();
    this._unsubscribeSession = null;
    this._listeners.clear();
  }

  onEvent(listener: EventListener): () => void {
    return this._client?.onEvent(listener) ?? (() => {});
  }

  // ---- Route changes --------------------------------------------------------

  /**
   * Called when the URL route changes. Metadata is read from SessionCache;
   * callers are responsible for fetching/populating that cache.
   */
  async setRoute(sessionId: string | null): Promise<void> {
    const newSessionId = sessionId ?? "";

    if (newSessionId === this.sessionId) return;

    if (!newSessionId) {
      // No session — clear everything
      this.setSessionSubscription("");
      this.projectId = null;
      this.sessionId = "";
      this.sessionData = blankSessionData();
      this.sessionMessages = [];
      this.notify();
      return;
    }

    const fetchId = ++this._fetchId;
    this.projectId = null;
    this.sessionId = newSessionId;
    this.setSessionSubscription(newSessionId);
    this.sessionData = blankSessionData(newSessionId);
    this.sessionMessages = [];
    if (!this.applySessionFromStore()) {
      this.notify();
    }

    await this.fetchSessionMessages(newSessionId, fetchId);
  }

  // ---- Actions --------------------------------------------------------------

  prompt(message: ClientPromptContent): boolean {
    if (!this._client || !this.sessionId) return false;
    this._client.prompt(this.sessionId, message);
    return true;
  }

  steer(message: ClientPromptContent): boolean {
    if (!this._client || !this.sessionId) return false;
    this._client.steer(this.sessionId, message);
    return true;
  }

  abort(): boolean {
    if (!this._client || !this.sessionId) return false;
    this._client.abort(this.sessionId);
    return true;
  }

  async uploadAttachments(attachments: readonly SessionAttachmentUpload[]): Promise<AttachmentInfo[]> {
    if (attachments.length === 0) return [];
    if (!this.sessionId) throw new Error("No active session");

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

  /**
   * Re-read the active session's metadata from the shared SessionCache.
   * The active store does not fetch session metadata itself; AppStore owns
   * server refresh decisions and writes results into SessionCache.
   */
  async refreshSession() {
    if (!this.sessionId) return;

    const wasStreaming = this.sessionData.state.isStreaming;
    const applied = this.applySessionFromStore();
    if (!applied) return;

    // If streaming just ended (missed agent_end during disconnect/navigation),
    // also refresh messages to pick up the completed turn's results.
    if (wasStreaming && !this.sessionData.state.isStreaming) {
      await this.fetchSessionMessages(this.sessionId);
    }
  }

  /** Load persisted messages for the active session. */
  async refreshMessages() {
    if (this.sessionId) {
      await this.fetchSessionMessages(this.sessionId);
    }
  }

  async updateSessionModel(update: SessionModelUpdate): Promise<{ ok: true } | { error: string }> {
    if (!this.sessionId) return { error: "No active session" };

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

      this.applySessionModelChange(this.sessionId, update);
      return { ok: true };
    } catch {
      return { error: "Network error" };
    }
  }

  applySessionModelChange(sessionId: string, update: SessionModelUpdate): void {
    if (sessionId !== this.sessionId) return;

    this.sessionData = {
      ...this.sessionData,
      runtimeType: update.runtimeType ?? this.sessionData.runtimeType,
      state: {
        ...this.sessionData.state,
        model: { provider: update.provider, id: update.modelId },
        thinkingLevel: update.thinkingLevel,
      },
    };
    this.notify();
  }

  // ---- Internal fetching ----------------------------------------------------

  private setSessionSubscription(sessionId: string): void {
    this._unsubscribeSession?.();
    this._unsubscribeSession = sessionId
      ? this._sessionCache.subscribe(sessionId, () => { void this.refreshSession(); })
      : null;
  }

  private applySessionFromStore(): boolean {
    const data = this._sessionCache.getDetail(this.sessionId);
    if (!data) return false;

    this.sessionData = data;
    this.projectId = data.projectId;
    this.notify();
    return true;
  }

  private async fetchSessionMessages(sessionId: string, fetchId = this._fetchId): Promise<boolean> {
    try {
      const resp = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages`);
      if (!resp.ok) return false;
      if (fetchId !== this._fetchId) return false; // stale
      const data: AgentMessage[] = await resp.json();
      this.sessionMessages = data;
      this.notify();
      return true;
    } catch {
      return false;
    }
  }
}

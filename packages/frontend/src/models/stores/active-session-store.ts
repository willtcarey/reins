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
    task_id: null,
    runtimeType: undefined,
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
  private _fetchId = 0; // guards against stale session fetches

  constructor(private _client: IAppClient | null = null) {}

  // ---- Subscription ---------------------------------------------------------

  subscribe(fn: ActiveSessionStoreListener): () => void {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  private notify() {
    for (const fn of this._listeners) fn();
  }

  onEvent(listener: EventListener): () => void {
    return this._client?.onEvent(listener) ?? (() => {});
  }

  // ---- Route changes --------------------------------------------------------

  /**
   * Called when the URL route changes. Derives the projectId from the
   * session data via the top-level session lookup endpoint.
   */
  async setRoute(sessionId: string | null): Promise<void> {
    const newSessionId = sessionId ?? "";

    if (newSessionId === this.sessionId) return;

    if (!newSessionId) {
      // No session — clear everything
      this.projectId = null;
      this.sessionId = "";
      this.sessionData = blankSessionData();
      this.sessionMessages = [];
      this.notify();
      return;
    }

    this.sessionId = newSessionId;
    this.sessionData = blankSessionData(newSessionId);
    this.sessionMessages = [];
    this.notify();

    await this.fetchSessionWithMessages(newSessionId);
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
   * Re-fetch the active session's metadata. Call on WebSocket reconnect.
   * Messages are intentionally kept separate so metadata refreshes do not
   * clobber in-flight chat UI state mid-turn.
   */
  async refreshSession() {
    if (this.sessionId) {
      const wasStreaming = this.sessionData.state.isStreaming;
      // Reuse the current route fetch ID so metadata refreshes don't invalidate
      // an in-flight message load for the same session on initial page load.
      await this.fetchSessionMetadata(this.sessionId, this._fetchId);
      // If streaming just ended (missed agent_end during disconnect/navigation),
      // also refresh messages to pick up the completed turn's results.
      if (wasStreaming && !this.sessionData.state.isStreaming) {
        await this.fetchSessionMessages(this.sessionId);
      }
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

  /**
   * Fetch session metadata and persisted messages in parallel. Keeping them
   * separate lets the chat UI ignore metadata-only refreshes while a run is
   * still streaming.
   */
  private async fetchSessionWithMessages(sessionId: string): Promise<void> {
    const fetchId = ++this._fetchId;
    await Promise.all([
      this.fetchSessionMetadata(sessionId, fetchId),
      this.fetchSessionMessages(sessionId, fetchId),
    ]);
  }

  /**
   * Fetch a session via the top-level endpoint (not project-scoped).
   * Updates sessionData and derives projectId from the response.
   */
  private async fetchSessionMetadata(sessionId: string, fetchId = ++this._fetchId): Promise<boolean> {
    try {
      const resp = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}`,
      );
      if (!resp.ok) return false;
      if (fetchId !== this._fetchId) return false; // stale
      const data = await resp.json();
      this.sessionData = data;
      this.projectId = data.project_id;
      this.notify();
      return true;
    } catch {
      return false;
    }
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

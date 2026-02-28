/**
 * Active Session Store
 *
 * Tracks which session is currently being viewed: the session ID, its full
 * data, and the derived project ID (for diff context). Does NOT hold task
 * or session lists — that data lives in ProjectDataStore via ProjectStore.
 *
 * Components subscribe via `subscribe()` and read public state directly.
 * Mutations go through action methods which call the backend API.
 */

import type { SessionData } from "../ws-client.js";

export type ActiveSessionStoreListener = () => void;

export class ActiveSessionStore {
  // ---- Public reactive state ------------------------------------------------

  projectId: number | null = null;
  sessionId: string = "";
  sessionData: SessionData | null = null;

  // ---- Private state --------------------------------------------------------

  private _listeners = new Set<ActiveSessionStoreListener>();
  private _fetchId = 0; // guards against stale session fetches

  // ---- Subscription ---------------------------------------------------------

  subscribe(fn: ActiveSessionStoreListener): () => void {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  private notify() {
    for (const fn of this._listeners) fn();
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
      this.sessionData = null;
      this.notify();
      return;
    }

    this.sessionId = newSessionId;
    this.sessionData = null;
    this.notify();

    // Fetch session via top-level endpoint (includes project_id)
    await this.fetchSessionTopLevel(newSessionId);
  }

  // ---- Actions --------------------------------------------------------------

  /**
   * Re-fetch the active session's data. Call on WebSocket reconnect.
   */
  async refreshSession() {
    if (this.sessionId) {
      await this.fetchSession(this.sessionId);
    }
  }

  // ---- Internal fetching ----------------------------------------------------

  /**
   * Fetch a session via the top-level endpoint (not project-scoped).
   * Updates sessionData and projectId from the response.
   */
  private async fetchSessionTopLevel(sessionId: string): Promise<void> {
    const fetchId = ++this._fetchId;
    try {
      const resp = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}`,
      );
      if (!resp.ok) return;
      if (fetchId !== this._fetchId) return; // stale
      const data = await resp.json();
      this.sessionData = data;
      this.projectId = data.project_id;
      this.notify();
    } catch {
      // silent
    }
  }

  private async fetchSession(sessionId: string) {
    const fetchId = ++this._fetchId;
    try {
      const resp = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}`,
      );
      if (!resp.ok) return;
      if (fetchId !== this._fetchId) return; // stale
      this.sessionData = await resp.json();
      this.notify();
    } catch {
      // silent
    }
  }
}

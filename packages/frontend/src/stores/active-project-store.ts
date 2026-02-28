/**
 * Active Project Store
 *
 * Reactive store for the currently-selected project's state: task lists,
 * session lists, and the active session's full data. A single instance
 * is created by AppStore and shared with all components that need
 * project-level data.
 *
 * Components subscribe via `subscribe()` and read public state directly.
 * Mutations go through action methods which fetch from the backend and
 * update state.
 */

import type { SessionData, SessionListItem, TaskListItem } from "../ws-client.js";

export type ActiveProjectStoreListener = () => void;

export class ActiveProjectStore {
  // ---- Public reactive state ------------------------------------------------

  projectId: number | null = null;
  sessionId: string = "";

  tasks: TaskListItem[] = [];
  sessions: SessionListItem[] = [];
  sessionData: SessionData | null = null;

  loading = false;

  // ---- Private state --------------------------------------------------------

  private _listeners = new Set<ActiveProjectStoreListener>();
  private _fetchId = 0; // guards against stale session fetches

  // ---- Subscription ---------------------------------------------------------

  subscribe(fn: ActiveProjectStoreListener): () => void {
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
      this.tasks = [];
      this.sessions = [];
      this.sessionData = null;
      this.notify();
      return;
    }

    this.sessionId = newSessionId;
    this.sessionData = null;
    this.notify();

    // Fetch session via top-level endpoint (includes project_id)
    const data = await this.fetchSessionTopLevel(newSessionId);
    if (!data) return;

    const projectChanged = data.project_id !== this.projectId;
    if (projectChanged) {
      this.projectId = data.project_id;
      this.tasks = [];
      this.sessions = [];
      this.notify();
      await this.fetchLists();
    }
  }

  // ---- Actions --------------------------------------------------------------

  /**
   * Refresh task and session lists. Call after agent_end, session creation, etc.
   */
  async refreshLists() {
    await this.fetchLists();
  }

  /**
   * Re-fetch the active session's data. Call on WebSocket reconnect.
   */
  async refreshSession() {
    if (this.sessionId) {
      await this.fetchSession(this.sessionId);
    }
  }

  /**
   * Create a new scratch session. Returns the new session ID for navigation.
   */
  async createSession(): Promise<string | null> {
    if (this.projectId == null) return null;
    try {
      const resp = await fetch(
        `/api/projects/${this.projectId}/sessions`,
        { method: "POST" },
      );
      if (!resp.ok) return null;
      const data: SessionData = await resp.json();
      return data.id;
    } catch {
      return null;
    }
  }

  /**
   * Create a new session under a task. Returns the new session ID for
   * navigation, or an error string.
   */
  async createTaskSession(
    taskId: number,
  ): Promise<{ sessionId: string } | { error: string }> {
    if (this.projectId == null) return { error: "No project" };
    try {
      const resp = await fetch(
        `/api/projects/${this.projectId}/tasks/${taskId}/sessions`,
        { method: "POST" },
      );
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        return { error: body.error || `HTTP ${resp.status}` };
      }
      const data: SessionData = await resp.json();
      // Refresh lists to pick up the new session
      await this.fetchLists();
      return { sessionId: data.id };
    } catch {
      return { error: "Network error" };
    }
  }

  /**
   * Update a task's title and/or description. Returns success or an error string.
   */
  async updateTask(
    taskId: number,
    updates: { title?: string; description?: string | null },
  ): Promise<{ ok: true } | { error: string }> {
    if (this.projectId == null) return { error: "No project" };
    try {
      const resp = await fetch(
        `/api/projects/${this.projectId}/tasks/${taskId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(updates),
        },
      );
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        return { error: body.error || `HTTP ${resp.status}` };
      }
      await this.fetchLists();
      return { ok: true };
    } catch {
      return { error: "Network error" };
    }
  }

  /**
   * Delete a task. Returns success or an error string.
   */
  async deleteTask(taskId: number): Promise<{ ok: true } | { error: string }> {
    if (this.projectId == null) return { error: "No project" };
    try {
      const resp = await fetch(
        `/api/projects/${this.projectId}/tasks/${taskId}`,
        { method: "DELETE" },
      );
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        return { error: body.error || `HTTP ${resp.status}` };
      }
      // If the active session belonged to this task, clear it
      if (this.sessionData?.task_id === taskId) {
        this.sessionId = "";
        this.sessionData = null;
      }
      await this.fetchLists();
      return { ok: true };
    } catch {
      return { error: "Network error" };
    }
  }

  /**
   * Generate a task from a freeform prompt. Returns success or error.
   */
  async generateTask(
    prompt: string,
  ): Promise<{ ok: true } | { error: string }> {
    if (this.projectId == null) return { error: "No project" };
    try {
      const resp = await fetch(
        `/api/projects/${this.projectId}/tasks/generate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt }),
        },
      );
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        return { error: body.error || `Error creating task (HTTP ${resp.status})` };
      }
      await this.fetchLists();
      return { ok: true };
    } catch {
      return { error: "Network error" };
    }
  }

  // ---- Internal fetching ----------------------------------------------------

  private async fetchLists() {
    if (this.projectId == null) return;
    this.loading = true;
    this.notify();
    try {
      const [tasksResp, sessionsResp] = await Promise.all([
        fetch(`/api/projects/${this.projectId}/tasks`),
        fetch(`/api/projects/${this.projectId}/sessions`),
      ]);
      if (tasksResp.ok) this.tasks = await tasksResp.json();
      if (sessionsResp.ok) this.sessions = await sessionsResp.json();
    } catch {
      // silent
    }
    this.loading = false;
    this.notify();
  }

  /**
   * Fetch a session via the top-level endpoint (not project-scoped).
   * Returns the session data including project_id, or null on failure.
   */
  private async fetchSessionTopLevel(sessionId: string): Promise<(SessionData & { project_id: number }) | null> {
    const fetchId = ++this._fetchId;
    try {
      const resp = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}`,
      );
      if (!resp.ok) return null;
      if (fetchId !== this._fetchId) return null; // stale
      const data = await resp.json();
      this.sessionData = data;
      this.notify();
      return data;
    } catch {
      return null;
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

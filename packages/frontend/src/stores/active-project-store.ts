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
   * Called when the URL route changes. Handles project switches,
   * session switches, and bare project URLs (resolves to most recent).
   *
   * Returns a session ID to navigate to if the URL needs updating
   * (bare project URL resolved to a session), or null otherwise.
   */
  async setRoute(
    projectId: number | null,
    sessionId: string | null,
  ): Promise<{ navigateTo: string } | null> {
    const projectChanged = projectId !== this.projectId;
    const newSessionId = sessionId ?? "";
    const sessionChanged = newSessionId !== this.sessionId;

    if (!projectChanged && !sessionChanged) return null;

    if (projectChanged) {
      this.projectId = projectId;
      this.sessionId = newSessionId;
      this.tasks = [];
      this.sessions = [];
      this.sessionData = null;
      this.notify();

      if (projectId == null) return null;

      await this.fetchLists();

      if (newSessionId) {
        await this.fetchSession(newSessionId);
        return null;
      }

      // Bare project URL — resolve to most recent session
      if (this.sessions.length > 0) {
        return { navigateTo: this.sessions[0].id };
      }
      return null;
    }

    // Same project, different session
    this.sessionId = newSessionId;
    this.sessionData = null;
    this.notify();

    if (newSessionId) {
      await this.fetchSession(newSessionId);
    }
    return null;
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

  private async fetchSession(sessionId: string) {
    if (this.projectId == null) return;
    const fetchId = ++this._fetchId;
    try {
      const resp = await fetch(
        `/api/projects/${this.projectId}/sessions/${encodeURIComponent(sessionId)}`,
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

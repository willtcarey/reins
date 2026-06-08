/**
 * Projects Store
 *
 * Public project-domain store for the project list, project CRUD mutations,
 * lazily-created ProjectStore instances, and cross-project activity selectors.
 *
 * Owns a single shared ActivityStore — the single source of truth for all
 * session activity across all projects. ProjectStore instances receive a
 * reference to this store and read/write through it.
 *
 * Components subscribe via `subscribe()` to get notified when the project list
 * or any child store changes (notifications bubble up).
 */

import type { ProjectInfo } from "../ws-client.js";
import type { ActivityFinishOptions, ActivityState } from "./activity-store.js";
import { ActivityStore } from "./activity-store.js";
import { ProjectStore } from "./project-store.js";

type ProjectsStoreListener = () => void;

export class ProjectsStore {
  // ---- Public reactive state ------------------------------------------------

  projects: ProjectInfo[] = [];

  // ---- Private state --------------------------------------------------------

  /**
   * Single shared ActivityStore — all session activity for all projects.
   * Populated from the server activity snapshot, WebSocket events, and
   * session list fetches. ProjectStore instances read through this store.
   * Maintains both session-level and per-project activity state.
   */
  private _activity = new ActivityStore();

  private _stores = new Map<number, ProjectStore>();
  private _unsubscribes = new Map<number, () => void>();
  private _listeners = new Set<ProjectsStoreListener>();

  // ---- Subscription ---------------------------------------------------------

  subscribe(fn: ProjectsStoreListener): () => void {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  private notify() {
    for (const fn of this._listeners) fn();
  }

  // ---- Project list actions -------------------------------------------------

  /** Fetch the project list from the server. */
  async fetchProjects(): Promise<void> {
    try {
      const resp = await fetch("/api/projects");
      if (resp.ok) {
        this.projects = await resp.json();
        this.notify();
      }
    } catch {
      // silent
    }
  }

  /** Delete a project and refresh the list. */
  async deleteProject(projectId: number): Promise<void> {
    try {
      await fetch(`/api/projects/${projectId}`, { method: "DELETE" });
      this.remove(projectId);
      await this.fetchProjects();
    } catch {
      // silent
    }
  }

  /** Create a new project. Returns the created project on success. */
  async createProject(data: {
    name: string;
    path: string;
    base_branch: string;
  }): Promise<ProjectInfo | { error: string }> {
    try {
      const resp = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        return { error: body.error || "Failed to create project" };
      }
      const project: ProjectInfo = await resp.json();
      await this.fetchProjects();
      return project;
    } catch {
      return { error: "Network error" };
    }
  }

  /** Update a project's properties. */
  async updateProject(
    projectId: number,
    data: { name: string; path: string; base_branch: string },
  ): Promise<{ ok: true } | { error: string }> {
    try {
      const resp = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        return { error: body.error || "Failed to update project" };
      }
      await this.fetchProjects();
      return { ok: true };
    } catch {
      return { error: "Network error" };
    }
  }

  // ---- Activity mutations ---------------------------------------------------

  /**
   * The shared ActivityStore. Exposed so ProjectStore instances can
   * read activity state (read-only selectors).
   */
  get activityStore(): ActivityStore {
    return this._activity;
  }

  /** Activity state for a session (works for loaded and unloaded projects). */
  activityForSession(projectId: number, sessionId: string): ActivityState | undefined {
    return this._activity.getActivity(sessionId);
  }

  /**
   * Activity state for a project header. Derived on the fly from
   * ActivityStore — works for all projects regardless of load state.
   */
  activityForProject(projectId: number): ActivityState | undefined {
    return this._activity.activityForProject(projectId);
  }

  /** Summary counts across all project activity, for shell-level title/badge state. */
  get activitySummary(): { running: number; finished: number } {
    return this._activity.activitySummary;
  }

  /**
   * Mark a session as running. Applies the closed-task guard if the project
   * store is loaded; otherwise sets running unconditionally.
   */
  setRunning(sessionId: string, projectId: number): void {
    this._activity.setProjectForSession(sessionId, projectId);
    const store = this.peekStore(projectId);
    if (store?.tasks.hasClosedTaskSession(sessionId)) {
      this._activity.clearActivity(sessionId);
    } else {
      this._activity.setRunning(sessionId);
    }
    this.notify();
  }

  /**
   * Mark a session as finished. Applies the closed-task guard if the project
   * store is loaded; otherwise sets finished unconditionally.
   */
  setFinished(sessionId: string, projectId: number, options: ActivityFinishOptions = {}): void {
    this._activity.setProjectForSession(sessionId, projectId);
    const store = this.peekStore(projectId);
    if (store?.tasks.hasClosedTaskSession(sessionId)) {
      this._activity.clearActivity(sessionId);
    } else {
      this._activity.setFinished(sessionId, options);
    }
    this.notify();
  }

  /**
   * Track a delegate session so its activity is suppressed on completion.
   */
  trackDelegateSession(sessionId: string): void {
    this._activity.trackDelegateSession(sessionId);
    this.notify();
  }

  /**
   * Mark a session's activity as viewed: optimistic local update followed by
   * the server REST endpoint (transitions 'finished' → NULL, broadcasts to
   * other tabs). Rolls back the local update if the request fails.
   */
  async markSessionViewed(projectId: number, sessionId: string): Promise<void> {
    // Optimistic local update — UI responds immediately
    this._activity.markSessionViewed(sessionId);
    this.notify();
    try {
      const resp = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/activity`, {
        method: "PATCH",
      });
      if (!resp.ok) {
        // Roll back: restore finished state so reconnect reconciles
        this._activity.setFinished(sessionId);
        this.notify();
      }
    } catch {
      // Roll back on network failure too
      this._activity.setFinished(sessionId);
      this.notify();
    }
  }

  /**
   * Apply a server-authoritative activity state update. Called from
   * fetchActivitySnapshot() and by ProjectStore during list fetches.
   */
  applyServerState(sessionId: string, serverState: "running" | "finished" | null, projectId: number): void {
    this._activity.applyServerState(sessionId, serverState, projectId);
    this.notify();
  }

  /**
   * Clear activity for sessions belonging to closed tasks. If projectId is
   * given, only that project; otherwise all loaded projects.
   */
  clearActivityForClosedTasks(projectId?: number): void {
    const closedIds = new Set<string>();

    const storesToCheck: ProjectStore[] = projectId != null
      ? [this.peekStore(projectId)].filter((s): s is ProjectStore => s !== undefined)
      : [...this._stores.values()];

    for (const store of storesToCheck) {
      for (const id of store.tasks.closedTaskSessionIds) {
        closedIds.add(id);
      }
    }

    if (closedIds.size > 0) {
      this._activity.clearSessions(closedIds);
      this.notify();
    }
  }

  // ---- Activity snapshot ----------------------------------------------------

  /**
   * Fetch the server-side activity snapshot and apply it to the shared
   * ActivityStore. Activity dots are available immediately without needing
   * to expand any project.
   */
  async fetchActivitySnapshot(): Promise<void> {
    try {
      const resp = await fetch("/api/activity");
      if (!resp.ok) return;
      const sessions: Array<{ id: string; activity_state: "running" | "finished"; project_id: number }> = await resp.json();

      for (const entry of sessions) {
        this.applyServerState(entry.id, entry.activity_state, entry.project_id);
      }
    } catch {
      // silent — activity will be populated via session list fetches
    }
  }

  // ---- WS event routing -----------------------------------------------------

  /** Route an agent_start event into the activity model. */
  handleAgentStart(projectId: number, sessionId: string): void {
    this.setRunning(sessionId, projectId);
  }

  /** Route an agent_end event into the activity model and reconcile project lists. */
  handleAgentEnd(projectId: number, sessionId: string, options: ActivityFinishOptions = {}): void {
    this.setFinished(sessionId, projectId, options);
    setTimeout(() => {
      void this.refresh(projectId)
        .then(() => this.clearActivityForClosedTasks(projectId));
    }, 500);
  }

  // ---- Reconnect / event handling -------------------------------------------

  /**
   * Refresh loaded project data and reconcile activity after a WebSocket reconnect.
   * Since activity_state is now server-authoritative (persisted in DB),
   * refreshing session lists restores the correct activity state.
   */
  async handleReconnect(_activeSessionId: string | null = null): Promise<void> {
    await this.refreshAll();
    this.clearActivityForClosedTasks();
  }

  async handleTaskUpdated(projectId: number): Promise<void> {
    const projectStore = this.peekStore(projectId);
    if (!projectStore) return;

    await projectStore.fetchLists();
    this.clearActivityForClosedTasks(projectId);
  }

  async handleSessionCreated(event: {
    projectId: number;
    sessionId: string;
    taskId: number | null;
    parentSessionId: string | null;
  }): Promise<void> {
    const projectStore = event.parentSessionId
      ? this.getStore(event.projectId)
      : this.peekStore(event.projectId);

    if (event.parentSessionId) {
      this.trackDelegateSession(event.sessionId);
    }

    await this.refresh(event.projectId);

    if (event.taskId) {
      await projectStore?.fetchTaskSessions(event.taskId);
    }
  }

  // ---- Per-project data stores ----------------------------------------------

  /**
   * Get or create a ProjectStore for a project.
   * Creating does NOT fetch — call ensureLoaded() to trigger a fetch.
   */
  getStore(projectId: number): ProjectStore {
    let child = this._stores.get(projectId);
    if (child) return child;

    child = new ProjectStore(projectId, this._activity);
    const unsub = child.subscribe(() => this.notify());
    this._stores.set(projectId, child);
    this._unsubscribes.set(projectId, unsub);
    return child;
  }

  /**
   * Get a store only if it already exists (no creation).
   */
  peekStore(projectId: number): ProjectStore | undefined {
    return this._stores.get(projectId);
  }

  /**
   * Ensure a project's data is loaded. Creates the store if needed,
   * then fetches if not yet loaded and not currently loading.
   */
  async ensureLoaded(projectId: number): Promise<void> {
    const child = this.getStore(projectId);
    if (!child.loaded && !child.loading) {
      await child.fetchLists();
      this.clearActivityForClosedTasks(projectId);
    }
  }

  /**
   * Refresh a specific project's data. Re-fetches if the store exists,
   * no-op if it doesn't.
   */
  async refresh(projectId: number): Promise<void> {
    const child = this.peekStore(projectId);
    if (child) {
      await child.fetchLists();
      this.clearActivityForClosedTasks(projectId);
    }
  }

  /**
   * Refresh all loaded project stores. Called on WS reconnect to catch up
   * on missed events across every expanded project, not just the active one.
   */
  async refreshAll(): Promise<void> {
    const refreshes: Promise<void>[] = [];
    for (const child of this._stores.values()) {
      if (child.loaded) {
        refreshes.push(child.fetchLists());
      }
    }
    await Promise.all(refreshes);
  }

  // ---- File upload ------------------------------------------------------------

  /**
   * Upload files to a project directory via multipart form upload.
   * Uses XHR for progress tracking. Returns a promise that resolves with
   * the list of uploaded filenames on success or an error message on failure.
   */
  uploadFiles(
    projectId: number,
    files: FileList,
    onProgress?: (percent: number) => void,
  ): Promise<{ uploaded: string[] } | { error: string }> {
    return new Promise((resolve) => {
      const formData = new FormData();
      for (const file of files) {
        formData.append("files", file);
      }

      const xhr = new XMLHttpRequest();
      xhr.open("POST", `/api/projects/${projectId}/upload`);

      xhr.upload.addEventListener("progress", (e) => {
        if (e.lengthComputable) {
          onProgress?.(Math.round((e.loaded / e.total) * 100));
        }
      });

      xhr.addEventListener("load", () => {
        onProgress?.(100);
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const body = JSON.parse(xhr.responseText);
            resolve({ uploaded: body.uploaded ?? [] });
          } catch {
            resolve({ uploaded: [] });
          }
        } else {
          let detail: string;
          try {
            detail = JSON.parse(xhr.responseText).error ?? xhr.responseText;
          } catch {
            detail = xhr.responseText;
          }
          resolve({ error: `Upload failed (${xhr.status}): ${detail || xhr.statusText}` });
        }
      });

      xhr.addEventListener("error", () => {
        resolve({ error: "Upload failed (network error)." });
      });

      xhr.addEventListener("abort", () => {
        resolve({ error: "Upload aborted." });
      });

      onProgress?.(0);
      xhr.send(formData);
    });
  }

  /**
   * Drop a project data store (e.g. project deleted). Unsubscribes from
   * child notifications and removes from the map.
   */
  remove(projectId: number): void {
    const unsub = this._unsubscribes.get(projectId);
    if (!unsub) return;

    const child = this._stores.get(projectId);
    child?.dispose();
    unsub();
    this._unsubscribes.delete(projectId);
    this._stores.delete(projectId);
    this.notify();
  }
}

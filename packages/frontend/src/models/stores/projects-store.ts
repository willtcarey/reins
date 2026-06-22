/**
 * Projects Store
 *
 * Public project-domain store for the project list, project CRUD mutations,
 * lazily-created ProjectStore instances, and cross-project activity selectors.
 *
 * Owns cross-project activity behavior. Activity data itself lives in the
 * shared SessionCache and is derived by ProjectsStore/ProjectStore selectors.
 *
 * Components subscribe via `subscribe()` to get notified when the project list
 * or any child store changes (notifications bubble up).
 */

import type { ProjectInfo } from "../ws-client.js";
import { ProjectStore } from "./project-store.js";
import { SessionCache, type ActivityState } from "./session-cache.js";

type ProjectsStoreListener = () => void;

export class ProjectsStore {
  // ---- Public reactive state ------------------------------------------------

  projects: ProjectInfo[] = [];

  // ---- Private state --------------------------------------------------------

  private _stores = new Map<number, ProjectStore>();
  private _unsubscribes = new Map<number, () => void>();
  private _listeners = new Set<ProjectsStoreListener>();

  constructor(private _sessionCache: SessionCache = new SessionCache()) {
    this._sessionCache.subscribeAll(() => this.notify());
  }

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

  /** Activity state for a session (works for loaded and unloaded projects). */
  activityForSession(projectId: number, sessionId: string): ActivityState {
    return this._sessionCache.get(sessionId)?.activityState ?? null;
  }

  /** Activity state for a project header. Running wins over finished. */
  activityForProject(projectId: number): ActivityState {
    const projectSessions = this._sessionCache.entries().filter((session) => session.projectId === projectId);
    if (projectSessions.some((session) => session.activityState === "running")) return "running";
    if (projectSessions.some((session) => session.activityState === "finished")) return "finished";
    return null;
  }

  /** Summary counts across all project activity, for shell-level title/badge state. */
  get activitySummary(): { running: number; finished: number } {
    let running = 0;
    let finished = 0;
    for (const session of this._sessionCache.entries()) {
      if (session.activityState === "running") running++;
      else if (session.activityState === "finished") finished++;
    }
    return { running, finished };
  }

  // ---- Activity snapshot ----------------------------------------------------

  /**
   * Fetch the server-side activity snapshot into SessionCache so activity dots
   * are available immediately without needing to expand any project.
   */
  async fetchActivitySnapshot(): Promise<void> {
    try {
      const resp = await fetch("/api/sessions/activity");
      if (!resp.ok) return;
      const sessions: Array<{ id: string; activityState: "running" | "finished"; projectId: number; taskId: number | null }> = await resp.json();
      const snapshotIds = new Set(sessions.map((entry) => entry.id));
      const previousActivityIds = this._sessionCache
        .entries()
        .filter((session) => session.activityState)
        .map((session) => session.id);

      for (const entry of sessions) {
        this._sessionCache.set(entry.id, { projectId: entry.projectId, taskId: entry.taskId, activityState: entry.activityState });
      }
      for (const sessionId of previousActivityIds) {
        if (!snapshotIds.has(sessionId)) {
          this._sessionCache.set(sessionId, { activityState: null });
        }
      }
      this.notify();
    } catch {
      // silent — activity will be populated via session list fetches
    }
  }

  // ---- Reconnect / event handling -------------------------------------------

  /** Refresh project list, activity snapshot, and all loaded project stores from the server. */
  async refreshFromServer(): Promise<void> {
    await Promise.allSettled([
      this.fetchProjects(),
      this.fetchActivitySnapshot(),
      this.refreshAll(),
    ]);
  }

  async handleTaskUpdated(projectId: number): Promise<void> {
    const projectStore = this.peekStore(projectId);
    if (!projectStore) return;

    await projectStore.fetchLists();
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

    this._sessionCache.set(event.sessionId, {
      projectId: event.projectId,
      taskId: event.taskId,
      parentSessionId: event.parentSessionId,
    });

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

    child = new ProjectStore(projectId, this._sessionCache);
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
   * child notifications, removes from the map, and clears shared activity and
   * cached sessions for the project (including snapshot-only sessions where no
   * ProjectStore was ever created).
   */
  remove(projectId: number): void {
    const removedSessionIds = this.sessionIdsForProject(projectId);
    this._sessionCache.removeMany(removedSessionIds);

    const unsub = this._unsubscribes.get(projectId);
    if (unsub) {
      const child = this._stores.get(projectId);
      child?.dispose();
      unsub();
      this._unsubscribes.delete(projectId);
      this._stores.delete(projectId);
    }

    this.notify();
  }

  private sessionIdsForProject(projectId: number): string[] {
    return this._sessionCache
      .entries()
      .filter((session) => session.projectId === projectId)
      .map((session) => session.id);
  }
}

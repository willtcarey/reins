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

import type { ProjectView as ProjectInfo } from "@backend/routes/projects.js";
import type { NodeView } from "@backend/models/node.js";
import type { SessionCreateRequest } from "@backend/routes/project-sessions.js";
import type { InboundEventSource } from "../ws-client.js";
import { ReinsHttpError } from "@reins/client";
import { api } from "../api.js";
import { compareSessionListItems, isSessionListItem, ProjectStore } from "./project-store.js";
import type { SessionListView } from "@backend/models/sessions.js";
import { SessionCache, type ActivityState } from "./session-cache.js";

type ProjectsStoreListener = () => void;

export class ProjectsStore {
  // ---- Public reactive state ------------------------------------------------

  projects: ProjectInfo[] = [];

  /** The sessions of no project the browser shows, by activity (`GET /api/sessions`): the sidebar's
   * "Other sessions". The browser creates none; Reins features may (extensions). */
  unownedSessionIds: string[] = [];

  // ---- Private state --------------------------------------------------------

  private _stores = new Map<number, ProjectStore>();
  private _unsubscribes = new Map<number, () => void>();
  private _listeners = new Set<ProjectsStoreListener>();
  private _unsubscribers: Array<() => void> = [];

  constructor(
    private _sessionCache: SessionCache = new SessionCache(),
    eventSource?: InboundEventSource,
  ) {
    this._unsubscribers.push(this._sessionCache.subscribeAll(() => this.notify()));
    if (eventSource) {
      this._unsubscribers.push(eventSource.subscribe({
        task_updated: (message) => { void this.handleTaskUpdated(message.projectId); },
        session_created: (message) => { void this.handleSessionCreated(message); },
        session_updated: (message) => {
          void Promise.all([
            this._sessionCache.fetchDetail(message.sessionId),
            message.projectId === null ? this.fetchUnowned() : this.refresh(message.projectId),
          ]);
        },
      }));
    }
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
      this.projects = await api.projects.list();
      this.notify();
    } catch {
      // silent
    }
  }

  /** The sessions of no project to list, from the cache: not archived, pinned first, then by activity. */
  get unownedSessions(): SessionListView[] {
    return this.unownedSessionIds.flatMap((sessionId) => {
      const session = this._sessionCache.get(sessionId);
      return session && isSessionListItem(session) && session.archivedAt === null && session.projectId === null ? [session] : [];
    }).toSorted(compareSessionListItems);
  }

  /** Fetch the sessions of no project the browser shows. */
  async fetchUnowned(): Promise<void> {
    try {
      const sessions = await api.sessions.listUnowned();
      this._sessionCache.setMany(sessions);
      this.unownedSessionIds = sessions.map((session) => session.id);
      this.notify();
    } catch {
      // silent
    }
  }

  /** Delete a project and refresh the list. */
  async deleteProject(projectId: number): Promise<void> {
    try {
      await api.projects.delete(projectId);
      this.remove(projectId);
      await this.fetchProjects();
    } catch {
      // silent
    }
  }

  /** The nodes a new project's checkout can be on: every node not revoked. */
  async listNodes(): Promise<NodeView[] | { error: string }> {
    try {
      return (await api.nodes.list()).filter((node) => !node.revokedAt);
    } catch (error) {
      return { error: error instanceof ReinsHttpError ? error.message : "Network error" };
    }
  }

  /** Create a new project whose checkout is `path` on node `nodeId`. Returns the created project on success. */
  async createProject(data: {
    name: string;
    path: string;
    nodeId: string;
    base_branch: string;
  }): Promise<ProjectInfo | { error: string }> {
    try {
      const project = await api.projects.create(data);
      await this.fetchProjects();
      return project;
    } catch (error) {
      return { error: error instanceof ReinsHttpError ? error.message : "Network error" };
    }
  }

  /** Update a project's properties; `defaultSource` changes it (a directory not known yet is checked on its node). */
  async updateProject(
    projectId: number,
    data: { name: string; base_branch: string; defaultSource?: { nodeId: string; path: string } },
  ): Promise<{ ok: true } | { error: string }> {
    try {
      await api.projects.update(projectId, data);
      await this.fetchProjects();
      return { ok: true };
    } catch (error) {
      return { error: error instanceof ReinsHttpError ? error.message : "Network error" };
    }
  }

  // ---- Aggregate task and session mutations ---------------------------------

  async updateTask(
    projectId: number,
    taskId: number,
    updates: { title?: string; description?: string | null },
  ): Promise<{ ok: true } | { error: string }> {
    const store = this.peekStore(projectId);
    if (!store) return { error: "No project data" };
    return store.updateTask(taskId, updates);
  }

  async deleteTask(projectId: number, taskId: number): Promise<{ ok: true } | { error: string }> {
    const store = this.peekStore(projectId);
    if (!store) return { error: "No project data" };
    return store.deleteTask(taskId);
  }

  async generateTask(projectId: number, prompt: string): Promise<{ ok: true } | { error: string }> {
    const store = this.peekStore(projectId);
    if (!store) return { error: "No project data" };
    return store.generateTask(prompt);
  }

  async createSession(projectId: number, input: SessionCreateRequest = {}): Promise<{ sessionId: string } | { error: string }> {
    try {
      const data = await api.sessions.create(projectId, input);
      void this.refresh(projectId);
      return { sessionId: data.id };
    } catch (error) {
      return { error: error instanceof ReinsHttpError ? error.message : "Network error" };
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
      const sessions = await api.sessions.activity();
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
      this.fetchUnowned(),
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
    projectId: number | null;
    sessionId: string;
    taskId: number | null;
    parentSessionId: string | null;
  }): Promise<void> {
    if (event.projectId === null) {
      this._sessionCache.set(event.sessionId, { projectId: null, taskId: null, parentSessionId: event.parentSessionId });
      await this.fetchUnowned();
      return;
    }
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

  dispose(): void {
    for (const unsubscribe of this._unsubscribers) unsubscribe();
    this._unsubscribers = [];
    for (const unsubscribe of this._unsubscribes.values()) unsubscribe();
    this._unsubscribes.clear();
    for (const child of this._stores.values()) child.dispose();
    this._stores.clear();
    this._listeners.clear();
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

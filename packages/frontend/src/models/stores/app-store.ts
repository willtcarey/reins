/**
 * App Store
 *
 * Centralized reactive store that owns all server communication and
 * internal event handling. Wraps ActiveSessionStore for the viewed
 * session, ProjectsStore for the project list, per-project data and
 * activity selectors, and DiffStore for diff/sync state.
 * Handles WebSocket events
 * internally — views never participate in fetch/event decisions.
 */

import type { IAppClient } from "../ws-client.js";
import { ActiveSessionStore } from "./active-session-store.js";
import { ProjectsStore } from "./projects-store.js";
import type { ProjectStore } from "./project-store.js";
import { DiffStore } from "./diff-store.js";
import { SessionCache } from "./session-cache.js";
import type { ProjectInfo } from "../ws-client.js";
import { openInBrowserEvent } from "../../components/events.js";

// Tools that modify files and should trigger a diff refresh
const FILE_MODIFYING_TOOLS = new Set(["write", "edit", "bash"]);

export type AppStoreListener = () => void;

export class AppStore {
  // ---- Delegates ------------------------------------------------------------

  private _activeSession: ActiveSessionStore;
  private _client: IAppClient;

  // ---- Sub-stores -----------------------------------------------------------

  /** Canonical client-side session metadata cache. */
  readonly sessionCache = new SessionCache();

  /** Project list, per-project data, and project/task mutations. */
  readonly projectsStore = new ProjectsStore(this.sessionCache);

  /** Diff/sync sub-store — owned and coordinated by AppStore. */
  readonly diffStore = new DiffStore();

  // ---- Connection state -----------------------------------------------------

  connected = false;

  // ---- Subscription ---------------------------------------------------------

  private _listeners = new Set<AppStoreListener>();
  private _unsubChildren: (() => void)[] = [];
  private _removeBrowserResumeHandlers: (() => void) | null = null;
  private _serverReconcileInFlight: Promise<void> | null = null;

  /** Sub-stores whose notifications bubble up through AppStore. */
  private get _children(): { subscribe(fn: () => void): () => void }[] {
    return [this._activeSession, this.projectsStore, this.diffStore];
  }

  constructor(client: IAppClient) {
    this._client = client;
    this._activeSession = new ActiveSessionStore(client, this.sessionCache);

    // Forward sub-store notifications to our subscribers
    this._unsubChildren = this._children.map((s) => s.subscribe(() => this.notify()));

    // ---- WS event handling (moved from app.ts) ------------------------------

    client.onConnection((connected) => {
      this.connected = connected;
      this.notify();
      if (connected) {
        void this.requestServerReconcile();
      }
    });

    client.onEvent((sessionId, projectId, event) => {
      // Handle task_updated broadcast (not tagged with a sessionId)
      if (event.type === "task_updated") {
        void this.projectsStore.handleTaskUpdated(event.projectId);
        return;
      }

      // Handle open_file broadcast (agent triggered ui.openFile()).
      // Only open if the user is viewing the session that sent it.
      if (event.type === "open_file") {
        if (sessionId !== this._activeSession.sessionId) return;
        const lineRange = event.startLine != null && event.endLine != null
          ? { startLine: event.startLine, endLine: event.endLine }
          : undefined;
        document.dispatchEvent(openInBrowserEvent(event.path, lineRange));
        return;
      }

      // Handle session_created broadcast (server-side session creation, e.g. delegate)
      if (event.type === "session_created") {
        void this.projectsStore.handleSessionCreated(event);
        return;
      }

      if (event.type === "session_updated") {
        void this.handleSessionUpdated(event.sessionId, event.projectId);
        return;
      }

      // Only refresh diff for the session we're viewing
      if (sessionId !== this._activeSession.sessionId) return;

      const refreshDiff =
        (event.type === "tool_execution_end" && FILE_MODIFYING_TOOLS.has(event.toolName)) ||
        event.type === "agent_end";

      if (refreshDiff) {
        setTimeout(() => this.diffStore.refresh(), 500);
      }
    });
  }

  // ---- Project list accessors ------------------------------------------------

  get projects(): ProjectInfo[] { return this.projectsStore.projects; }

  // ---- ActiveSessionStore delegate accessors ---------------------------------

  get activeSessionStore(): ActiveSessionStore { return this._activeSession; }
  get projectId() { return this._activeSession.projectId; }
  get sessionId() { return this._activeSession.sessionId; }

  /** Summary counts across all project activity, for shell-level title/badge state. */
  get activitySummary(): { running: number; finished: number } {
    return this.projectsStore.activitySummary;
  }

  /**
   * The per-project store for the session currently being viewed, or `null`
   * when no project is active or its store hasn't been loaded yet.
   */
  get activeProjectStore(): ProjectStore | null {
    const projectId = this._activeSession.projectId;
    if (projectId == null) return null;
    return this.projectsStore.peekStore(projectId) ?? null;
  }

  // ---- ActiveSessionStore delegate methods -----------------------------------

  async setRoute(sessionId: string | null): Promise<void> {
    const previousProjectId = this._activeSession.projectId;
    const nextSessionId = sessionId ?? "";
    const detailPromise = nextSessionId
      ? this.sessionCache.fetchDetail(nextSessionId)
      : Promise.resolve();

    const routePromise = this._activeSession.setRoute(sessionId);
    await Promise.all([routePromise, detailPromise]);

    // Update diff store project when it changes
    if (this._activeSession.projectId !== previousProjectId) {
      this.diffStore.setProject(this._activeSession.projectId);
    }

    // After route is applied, resolve the branch for the diff store
    this._updateDiffBranch();
  }

  async updateTask(
    taskId: number,
    updates: { title?: string; description?: string | null },
  ): Promise<{ ok: true } | { error: string }> {
    const projectId = this._activeSession.projectId;
    if (projectId == null) return { error: "No project" };
    const store = this.projectsStore.peekStore(projectId);
    if (!store) return { error: "No project data" };
    return store.updateTask(taskId, updates);
  }

  async deleteTask(taskId: number): Promise<{ ok: true } | { error: string }> {
    const projectId = this._activeSession.projectId;
    if (projectId == null) return { error: "No project" };
    const store = this.projectsStore.peekStore(projectId);
    if (!store) return { error: "No project data" };
    const result = await store.deleteTask(taskId);
    if ("ok" in result && this._activeSession.sessionData?.taskId === taskId) {
      // Active session belonged to deleted task — clear it
      await this._activeSession.setRoute(null);
    }
    return result;
  }

  /** Delete a project — delegates to ProjectsStore and handles navigation. */
  async deleteProject(projectId: number): Promise<void> {
    return this.projectsStore.deleteProject(projectId);
  }

  /** Create a new project. Returns the created project on success. */
  async createProject(data: {
    name: string;
    path: string;
    base_branch: string;
  }): Promise<ProjectInfo | { error: string }> {
    return this.projectsStore.createProject(data);
  }

  /** Update a project's properties. */
  async updateProject(
    projectId: number,
    data: { name: string; path: string; base_branch: string },
  ): Promise<{ ok: true } | { error: string }> {
    return this.projectsStore.updateProject(projectId, data);
  }

  // ---- Session creation ------------------------------------------------------

  /** Create a new scratch session for a project. Returns the session ID on success. */
  async createSession(projectId: number): Promise<{ sessionId: string } | { error: string }> {
    try {
      const resp = await fetch(`/api/projects/${projectId}/sessions`, { method: "POST" });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        return { error: body.error || "Failed to create session" };
      }
      const data = await resp.json();
      this.projectsStore.refresh(projectId);
      return { sessionId: data.id };
    } catch {
      return { error: "Network error" };
    }
  }

  /** Create a new session for a task. Returns the session ID on success. */
  async createTaskSession(taskId: number, projectId: number): Promise<{ sessionId: string } | { error: string }> {
    try {
      const resp = await fetch(`/api/tasks/${taskId}/sessions`, { method: "POST" });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        return { error: body.error || "Failed to create session" };
      }
      const data = await resp.json();
      this.projectsStore.refresh(projectId);
      return { sessionId: data.id };
    } catch {
      return { error: "Network error" };
    }
  }

  // ---- Task generation -------------------------------------------------------

  async generateTask(
    projectId: number,
    prompt: string,
  ): Promise<{ ok: true } | { error: string }> {
    const store = this.projectsStore.peekStore(projectId);
    if (!store) return { error: "No project data" };
    return store.generateTask(prompt);
  }

  // ---- Server reconciliation (internal) --------------------------------------

  private async handleSessionUpdated(sessionId: string, projectId: number): Promise<void> {
    const detailPromise = this.sessionCache.fetchDetail(sessionId);
    const refreshPromise = this.projectsStore.refresh(projectId);

    await detailPromise;
    await refreshPromise;
  }

  private requestServerReconcile(): Promise<void> {
    if (this._serverReconcileInFlight) return this._serverReconcileInFlight;

    this._serverReconcileInFlight = this.reconcileFromServer().finally(() => {
      this._serverReconcileInFlight = null;
    });
    return this._serverReconcileInFlight;
  }

  private async reconcileFromServer(): Promise<void> {
    const activeSessionId = this._activeSession.sessionId || null;
    const tasks: Promise<unknown>[] = [
      // Always refresh the project list on reconnect/resume.
      this.projectsStore.fetchProjects(),
      // Fetch server-side activity snapshot so activity indicators appear
      // immediately — even for projects not yet expanded in the sidebar.
      this.projectsStore.fetchActivitySnapshot(),
      // Refresh loaded project stores so sidebar data and activity catch up
      // on events missed while disconnected/asleep.
      this.projectsStore.handleReconnect(activeSessionId),
    ];

    if (activeSessionId) {
      tasks.push((async () => {
        // Refresh active-session metadata and messages. The active session
        // subscribes to SessionCache, so fetching detail applies metadata;
        // always refresh messages to catch any events missed during the pause.
        await this.refreshActiveSessionFromServer();
        await this._activeSession.refreshMessages();
      })());
    }

    await Promise.allSettled(tasks);
  }

  private installBrowserResumeHandlers(): () => void {
    const reconcile = () => { void this.requestServerReconcile(); };
    const reconcileWhenVisible = () => {
      if (document.visibilityState === "visible") {
        reconcile();
      }
    };

    window.addEventListener("focus", reconcile);
    window.addEventListener("online", reconcile);
    window.addEventListener("pageshow", reconcile);
    document.addEventListener("visibilitychange", reconcileWhenVisible);

    return () => {
      window.removeEventListener("focus", reconcile);
      window.removeEventListener("online", reconcile);
      window.removeEventListener("pageshow", reconcile);
      document.removeEventListener("visibilitychange", reconcileWhenVisible);
    };
  }

  private async refreshActiveSessionFromServer(): Promise<void> {
    const sessionId = this._activeSession.sessionId;
    if (!sessionId) return;

    await this.sessionCache.fetchDetail(sessionId);
  }

  // ---- Diff branch resolution (internal) ------------------------------------

  /**
   * Resolve the viewed session's task branch and update the diff store.
   * Task sessions → task's branch_name; scratch sessions → null (HEAD).
   */
  private _updateDiffBranch() {
    const session = this._activeSession.sessionData;
    if (!session?.taskId) {
      this.diffStore.setBranch(null);
      return;
    }
    const projectId = this._activeSession.projectId;
    const task = projectId != null
      ? this.projectsStore.peekStore(projectId)?.tasksWithActivity.find(session.taskId)
      : undefined;
    this.diffStore.setBranch(task?.branch_name ?? null);
  }

  // ---- Subscription ---------------------------------------------------------

  subscribe(fn: AppStoreListener): () => void {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  private notify() {
    for (const fn of this._listeners) fn();
  }

  // ---- Lifecycle ------------------------------------------------------------

  /** Open the WebSocket connection. */
  connect() {
    this._removeBrowserResumeHandlers ??= this.installBrowserResumeHandlers();
    this._client.connect();
  }

  /** Close the WebSocket connection. */
  disconnect() {
    this._client.disconnect();
  }

  dispose() {
    this._removeBrowserResumeHandlers?.();
    this._removeBrowserResumeHandlers = null;
    for (const unsub of this._unsubChildren) unsub();
    this._unsubChildren = [];
    this._activeSession.dispose();
    this.diffStore.dispose();
    this._listeners.clear();
  }
}

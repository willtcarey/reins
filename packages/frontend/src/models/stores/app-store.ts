/**
 * App Store
 *
 * Centralized reactive store that owns all server communication and
 * internal event handling. Wraps ActiveSessionStore for the viewed
 * session, ProjectsStore for the project list, per-project data and
 * project-scoped activity stores, and DiffStore for diff/sync state.
 * Handles WebSocket events
 * internally — views never participate in fetch/event decisions.
 */

import type { IAppClient } from "../ws-client.js";
import { ActiveSessionStore } from "./active-session-store.js";
import { ProjectsStore } from "./projects-store.js";
import type { ProjectStore } from "./project-store.js";
import { DiffStore } from "./diff-store.js";
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

  /** Project list, per-project data, and project/task mutations. */
  readonly projectsStore = new ProjectsStore();

  /** Diff/sync sub-store — owned and coordinated by AppStore. */
  readonly diffStore = new DiffStore();

  // ---- Connection state -----------------------------------------------------

  connected = false;

  // ---- Subscription ---------------------------------------------------------

  private _listeners = new Set<AppStoreListener>();
  private _unsubChildren: (() => void)[] = [];

  /** Sub-stores whose notifications bubble up through AppStore. */
  private get _children(): { subscribe(fn: () => void): () => void }[] {
    return [this._activeSession, this.projectsStore, this.diffStore];
  }

  constructor(client: IAppClient) {
    this._client = client;
    this._activeSession = new ActiveSessionStore(client);

    // Forward sub-store notifications to our subscribers
    this._unsubChildren = this._children.map((s) => s.subscribe(() => this.notify()));

    // ---- WS event handling (moved from app.ts) ------------------------------

    client.onConnection((connected) => {
      this.connected = connected;
      this.notify();
      if (connected) {
        // Always refresh the project list on (re)connect
        this.projectsStore.fetchProjects();
        // Refresh all loaded project stores (any expanded in the sidebar)
        // so session/task lists catch up on missed events, then drop any
        // stale activity for tasks that were closed while disconnected.
        void this.projectsStore.refreshAll()
          .then(() => this.projectsStore.clearActivityForClosedTasks());
        // Refresh active-session metadata and messages. refreshSession()
        // auto-triggers a message refresh when it detects streaming ended
        // (missed agent_end during disconnect). We also always refresh
        // messages to catch any events missed during the disconnection.
        if (this._activeSession.sessionId) {
          this._activeSession.refreshSession();
          this._activeSession.refreshMessages();
        }
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
        this.projectsStore.refresh(event.projectId);
        if (sessionId === this._activeSession.sessionId) {
          void this._activeSession.refreshSession();
        }
        return;
      }

      // Track activity for all sessions
      if (sessionId && event.type === "agent_start") {
        this.projectsStore.handleAgentStart(projectId, sessionId);
      } else if (sessionId && event.type === "agent_end") {
        this.projectsStore.handleAgentEnd(projectId, sessionId, {
          suppressUnread: sessionId === this._activeSession.sessionId,
        });
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

  markActiveSessionViewed(): void {
    const projectId = this._activeSession.projectId;
    const sessionId = this._activeSession.sessionId;
    if (projectId == null || !sessionId) return;
    this.projectsStore.markSessionViewed(projectId, sessionId);
  }

  async setRoute(sessionId: string | null): Promise<void> {
    const previousProjectId = this._activeSession.projectId;

    await this._activeSession.setRoute(sessionId);

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
    if ("ok" in result && this._activeSession.sessionData?.task_id === taskId) {
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

  // ---- Diff branch resolution (internal) ------------------------------------

  /**
   * Resolve the viewed session's task branch and update the diff store.
   * Task sessions → task's branch_name; scratch sessions → null (HEAD).
   */
  private _updateDiffBranch() {
    const session = this._activeSession.sessionData;
    if (!session?.task_id) {
      this.diffStore.setBranch(null);
      return;
    }
    const projectId = this._activeSession.projectId;
    const task = projectId != null
      ? this.projectsStore.peekStore(projectId)?.tasksWithActivity.find(session.task_id)
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
    this._client.connect();
  }

  /** Close the WebSocket connection. */
  disconnect() {
    this._client.disconnect();
  }

  dispose() {
    for (const unsub of this._unsubChildren) unsub();
    this._unsubChildren = [];
    this.diffStore.dispose();
    this._listeners.clear();
  }
}

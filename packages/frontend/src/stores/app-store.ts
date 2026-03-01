/**
 * App Store
 *
 * Centralized reactive store that owns all server communication and
 * internal event handling. Wraps ActiveSessionStore for the viewed
 * session, ProjectCollectionStore for the project list and per-project data,
 * and DiffStore for diff/sync state. Handles WebSocket events
 * internally — views never participate in fetch/event decisions.
 */

import { AppClient } from "../ws-client.js";
import { ActiveSessionStore } from "./active-session-store.js";
import { ProjectCollectionStore } from "./project-collection-store.js";
import { DiffStore } from "./diff-store.js";
import type { ProjectInfo, SessionData } from "../ws-client.js";

/** Activity state for a session: running, finished, or absent (no entry). */
export type ActivityState = "running" | "finished";

// Tools that modify files and should trigger a diff refresh
const FILE_MODIFYING_TOOLS = new Set(["write", "edit", "bash"]);

export type AppStoreListener = () => void;

export class AppStore {
  // ---- Delegates ------------------------------------------------------------

  private _activeSession = new ActiveSessionStore();
  private _client: AppClient;

  // ---- Sub-stores -----------------------------------------------------------

  /** Project list, per-project data, and project/task mutations. */
  readonly projectCollectionStore = new ProjectCollectionStore();

  /** Diff/sync sub-store — owned and coordinated by AppStore. */
  readonly diffStore = new DiffStore();

  // ---- Activity state (absorbed from ActivityTracker) -----------------------

  private _activityStates = new Map<string, { state: ActivityState; projectId: number }>();
  private _activityMapCache: Map<string, ActivityState> | null = null;

  // ---- Connection state -----------------------------------------------------

  connected = false;

  // ---- Subscription ---------------------------------------------------------

  private _listeners = new Set<AppStoreListener>();
  private _unsubChildren: (() => void)[] = [];

  /** Sub-stores whose notifications bubble up through AppStore. */
  private get _children(): { subscribe(fn: () => void): () => void }[] {
    return [this._activeSession, this.projectCollectionStore, this.diffStore];
  }

  constructor(client: AppClient) {
    this._client = client;

    // Forward sub-store notifications to our subscribers
    this._unsubChildren = this._children.map((s) => s.subscribe(() => this.notify()));

    // ---- WS event handling (moved from app.ts) ------------------------------

    client.onConnection((connected) => {
      this.connected = connected;
      this.notify();
      if (connected) {
        // Always refresh the project list on (re)connect
        this.projectCollectionStore.fetchProjects();
        // On reconnect, re-fetch the active session to catch up on missed events
        if (this._activeSession.sessionId) {
          this._activeSession.refreshSession();
        }
      }
    });

    client.onEvent((sessionId, projectId, event) => {
      // Handle task_updated broadcast (not tagged with a sessionId)
      if (event.type === "task_updated") {
        this.projectCollectionStore.refresh(event.projectId);
        return;
      }

      // Handle session_created broadcast (server-side session creation, e.g. delegate)
      if (event.type === "session_created") {
        this.projectCollectionStore.refresh(event.projectId);
        if (event.taskId) {
          this.projectCollectionStore.peekStore(event.projectId)?.fetchTaskSessions(event.taskId);
        }
        return;
      }

      // Track activity for all sessions
      if (sessionId && event.type === "agent_start") {
        this._setRunning(sessionId, projectId);
      } else if (sessionId && event.type === "agent_end") {
        this._setFinished(sessionId, projectId, this._activeSession.sessionId);
        setTimeout(() => this.projectCollectionStore.refresh(projectId), 500);
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

  get projects(): ProjectInfo[] { return this.projectCollectionStore.projects; }

  // ---- ActiveSessionStore delegate accessors ---------------------------------

  get projectId() { return this._activeSession.projectId; }
  get sessionId() { return this._activeSession.sessionId; }
  get sessionData(): SessionData | null { return this._activeSession.sessionData; }

  // ---- Activity state accessors ---------------------------------------------

  /** Get the activity state for a session (undefined = normal/no activity). */
  getActivity(sessionId: string): ActivityState | undefined {
    return this._activityStates.get(sessionId)?.state;
  }

  /** Get the projectId associated with a session's activity. */
  getActivityProjectId(sessionId: string): number | undefined {
    return this._activityStates.get(sessionId)?.projectId;
  }

  /** Get a snapshot of all activity states (for passing as a property). */
  get activityMap(): Map<string, ActivityState> {
    if (!this._activityMapCache) {
      const map = new Map<string, ActivityState>();
      for (const [id, entry] of this._activityStates) {
        map.set(id, entry.state);
      }
      this._activityMapCache = map;
    }
    return this._activityMapCache;
  }

  /**
   * Aggregate activity by projectId.
   * If any session in a project is running, the project is "running".
   * Otherwise if any session is finished, it's "finished".
   */
  get activityByProject(): Map<number, ActivityState> {
    const result = new Map<number, ActivityState>();
    for (const entry of this._activityStates.values()) {
      const current = result.get(entry.projectId);
      if (!current || (current === "finished" && entry.state === "running")) {
        result.set(entry.projectId, entry.state);
      }
    }
    return result;
  }

  /** Summary counts for favicon/title. */
  get activitySummary(): { running: number; finished: number } {
    let running = 0;
    let finished = 0;
    for (const entry of this._activityStates.values()) {
      if (entry.state === "running") running++;
      else if (entry.state === "finished") finished++;
    }
    return { running, finished };
  }

  /** Whether there's any activity at all. */
  get hasActivity(): boolean {
    return this._activityStates.size > 0;
  }

  // ---- Activity state mutations (private) -----------------------------------

  private _setRunning(sessionId: string, projectId: number): void {
    if (this._activityStates.get(sessionId)?.state === "running") return;
    this._activityStates.set(sessionId, { state: "running", projectId });
    this._activityMapCache = null;
    this.notify();
  }

  private _setFinished(sessionId: string, projectId: number, activeSessionId: string): void {
    if (sessionId === activeSessionId) {
      this.clearActivity(sessionId);
      return;
    }
    this._activityStates.set(sessionId, { state: "finished", projectId });
    this._activityMapCache = null;
    this.notify();
  }

  /** Clear activity state for a session (e.g., user viewed it). */
  clearActivity(sessionId: string): void {
    if (!this._activityStates.has(sessionId)) return;
    this._activityStates.delete(sessionId);
    this._activityMapCache = null;
    this.notify();
  }

  // ---- ActiveSessionStore delegate methods -----------------------------------

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

  async refreshSession() {
    return this._activeSession.refreshSession();
  }

  async updateTask(
    taskId: number,
    updates: { title?: string; description?: string | null },
  ): Promise<{ ok: true } | { error: string }> {
    const projectId = this._activeSession.projectId;
    if (projectId == null) return { error: "No project" };
    const store = this.projectCollectionStore.peekStore(projectId);
    if (!store) return { error: "No project data" };
    return store.updateTask(taskId, updates);
  }

  async deleteTask(taskId: number): Promise<{ ok: true } | { error: string }> {
    const projectId = this._activeSession.projectId;
    if (projectId == null) return { error: "No project" };
    const store = this.projectCollectionStore.peekStore(projectId);
    if (!store) return { error: "No project data" };
    const result = await store.deleteTask(taskId);
    if ("ok" in result && this._activeSession.sessionData?.task_id === taskId) {
      // Active session belonged to deleted task — clear it
      await this._activeSession.setRoute(null);
    }
    return result;
  }

  /** Delete a project — delegates to ProjectCollectionStore and handles navigation. */
  async deleteProject(projectId: number): Promise<void> {
    return this.projectCollectionStore.deleteProject(projectId);
  }

  /** Create a new project. Returns the created project on success. */
  async createProject(data: {
    name: string;
    path: string;
    base_branch: string;
  }): Promise<ProjectInfo | { error: string }> {
    return this.projectCollectionStore.createProject(data);
  }

  /** Update a project's properties. */
  async updateProject(
    projectId: number,
    data: { name: string; path: string; base_branch: string },
  ): Promise<{ ok: true } | { error: string }> {
    return this.projectCollectionStore.updateProject(projectId, data);
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
      this.projectCollectionStore.refresh(projectId);
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
      this.projectCollectionStore.refresh(projectId);
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
    const store = this.projectCollectionStore.peekStore(projectId);
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
    const tasks = projectId != null
      ? this.projectCollectionStore.peekStore(projectId)?.tasks ?? []
      : [];
    const task = tasks.find((t) => t.id === session.task_id);
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

  // ---- Client access (for commands) -----------------------------------------

  /** The underlying WebSocket client — for sending commands (prompt, steer, abort). */
  get client(): AppClient {
    return this._client;
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

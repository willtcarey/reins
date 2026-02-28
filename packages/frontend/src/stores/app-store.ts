/**
 * App Store
 *
 * Centralized reactive store that owns all server communication and
 * internal event handling. Wraps ProjectStore for project/session state,
 * owns DiffStore for diff/sync state, absorbs ActivityTracker for
 * session activity, and handles WebSocket events internally — views
 * never participate in fetch/event decisions.
 *
 * Migration steps 1–2: WS event handling + ActivityTracker merged in,
 * DiffStore owned and coordinated.
 * See docs/plans/reactive-store.md for the full plan.
 */

import { AppClient } from "../ws-client.js";
import { ActiveProjectStore } from "./active-project-store.js";
import { ProjectStore } from "./project-store.js";
import { DiffStore } from "./diff-store.js";
import type { ProjectInfo, SessionData, SessionListItem, TaskListItem } from "../ws-client.js";

/** Activity state for a session: running, finished, or absent (no entry). */
export type ActivityState = "running" | "finished";

// Tools that modify files and should trigger a diff refresh
const FILE_MODIFYING_TOOLS = new Set(["write", "edit", "bash"]);

export type AppStoreListener = () => void;

export class AppStore {
  // ---- Delegates ------------------------------------------------------------

  private _activeProject = new ActiveProjectStore();
  private _client: AppClient;

  // ---- Sub-stores -----------------------------------------------------------

  /** Project list sub-store. */
  readonly projectStore = new ProjectStore();

  /** Diff/sync sub-store — owned and coordinated by AppStore. */
  readonly diffStore = new DiffStore();

  // ---- Activity state (absorbed from ActivityTracker) -----------------------

  private _activityStates = new Map<string, { state: ActivityState; projectId: number }>();
  private _activityMapCache: Map<string, ActivityState> | null = null;

  // ---- Task session sublists --------------------------------------------------

  private _taskSessions = new Map<number, SessionListItem[]>();

  // ---- Connection state -----------------------------------------------------

  connected = false;

  // ---- Subscription ---------------------------------------------------------

  private _listeners = new Set<AppStoreListener>();
  private _unsubChildren: (() => void)[] = [];

  /** Sub-stores whose notifications bubble up through AppStore. */
  private get _children(): { subscribe(fn: () => void): () => void }[] {
    return [this._activeProject, this.projectStore, this.diffStore];
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
        this.projectStore.fetchProjects();
        // On reconnect, re-fetch the active session to catch up on missed events
        if (this._activeProject.sessionId) {
          this._activeProject.refreshSession();
        }
      }
    });

    client.onEvent((sessionId, projectId, event) => {
      const store = this._activeProject;

      // Handle task_updated broadcast (not tagged with a sessionId)
      if (event.type === "task_updated" && event.projectId === store.projectId) {
        store.refreshLists();
        return;
      }

      // Handle session_created broadcast (server-side session creation, e.g. delegate)
      if (event.type === "session_created" && event.projectId === store.projectId) {
        store.refreshLists();
        if (event.taskId) {
          this.fetchTaskSessions(event.taskId);
        }
        return;
      }

      // Track activity for all sessions
      if (sessionId && event.type === "agent_start") {
        this._setRunning(sessionId, projectId);
      } else if (sessionId && event.type === "agent_end") {
        this._setFinished(sessionId, projectId, store.sessionId);
        setTimeout(() => store.refreshLists(), 500);
      }

      // Only refresh diff for the session we're viewing
      if (sessionId !== store.sessionId) return;

      const refreshDiff =
        (event.type === "tool_execution_end" && FILE_MODIFYING_TOOLS.has(event.toolName)) ||
        event.type === "agent_end";

      if (refreshDiff) {
        setTimeout(() => this.diffStore.refresh(), 500);
      }
    });
  }

  // ---- Project list accessors ------------------------------------------------

  get projects(): ProjectInfo[] { return this.projectStore.projects; }

  // ---- ActiveProjectStore delegate accessors --------------------------------

  get projectId() { return this._activeProject.projectId; }
  get sessionId() { return this._activeProject.sessionId; }
  get tasks(): TaskListItem[] { return this._activeProject.tasks; }
  get sessions(): SessionListItem[] { return this._activeProject.sessions; }
  get sessionData(): SessionData | null { return this._activeProject.sessionData; }
  get loading() { return this._activeProject.loading; }

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

  // ---- Task session sublist accessors ----------------------------------------

  get taskSessions(): Map<number, SessionListItem[]> { return this._taskSessions; }

  // ---- Task session sublist actions -----------------------------------------

  /** Fetch sessions for a specific task and update the cache. */
  async fetchTaskSessions(taskId: number): Promise<void> {
    const projectId = this._activeProject.projectId;
    if (projectId == null) return;
    try {
      const resp = await fetch(
        `/api/projects/${projectId}/tasks/${taskId}/sessions`,
      );
      if (resp.ok) {
        const sessions: SessionListItem[] = await resp.json();
        // Skip update if data hasn't changed
        const existing = this._taskSessions.get(taskId);
        if (existing && JSON.stringify(existing) === JSON.stringify(sessions)) {
          return;
        }
        const next = new Map(this._taskSessions);
        next.set(taskId, sessions);
        this._taskSessions = next;
        this.notify();
      }
    } catch {
      // silent
    }
  }

  // ---- ActiveProjectStore delegate methods ----------------------------------

  async setRoute(
    projectId: number | null,
    sessionId: string | null,
  ): Promise<{ navigateTo: string } | null> {
    // Update diff store project when it changes
    if (projectId !== this._activeProject.projectId) {
      this.diffStore.setProject(projectId);
      // Clear cached task sessions on project change
      this._taskSessions = new Map();
    }

    const result = await this._activeProject.setRoute(projectId, sessionId);

    // After route is applied, resolve the branch for the diff store
    this._updateDiffBranch();

    return result;
  }

  async refreshLists() {
    return this._activeProject.refreshLists();
  }

  async refreshSession() {
    return this._activeProject.refreshSession();
  }

  async createSession(): Promise<string | null> {
    return this._activeProject.createSession();
  }

  async createTaskSession(
    taskId: number,
  ): Promise<{ sessionId: string } | { error: string }> {
    return this._activeProject.createTaskSession(taskId);
  }

  async updateTask(
    taskId: number,
    updates: { title?: string; description?: string | null },
  ): Promise<{ ok: true } | { error: string }> {
    return this._activeProject.updateTask(taskId, updates);
  }

  async deleteTask(taskId: number): Promise<{ ok: true } | { error: string }> {
    return this._activeProject.deleteTask(taskId);
  }

  /** Delete a project — delegates to ProjectStore and handles navigation. */
  async deleteProject(projectId: number): Promise<void> {
    return this.projectStore.deleteProject(projectId);
  }

  /** Create a new project. Returns the created project on success. */
  async createProject(data: {
    name: string;
    path: string;
    base_branch: string;
  }): Promise<ProjectInfo | { error: string }> {
    return this.projectStore.createProject(data);
  }

  /** Update a project's properties. */
  async updateProject(
    projectId: number,
    data: { name: string; path: string; base_branch: string },
  ): Promise<{ ok: true } | { error: string }> {
    return this.projectStore.updateProject(projectId, data);
  }

  // ---- Task generation -------------------------------------------------------

  async generateTask(
    projectId: number,
    prompt: string,
  ): Promise<{ ok: true } | { error: string }> {
    return this._activeProject.generateTask(prompt);
  }

  // ---- Diff branch resolution (internal) ------------------------------------

  /**
   * Resolve the viewed session's task branch and update the diff store.
   * Task sessions → task's branch_name; scratch sessions → null (HEAD).
   */
  private _updateDiffBranch() {
    const session = this._activeProject.sessionData;
    if (!session?.task_id) {
      this.diffStore.setBranch(null);
      return;
    }
    const task = this._activeProject.tasks.find((t) => t.id === session.task_id);
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

/**
 * App Store
 *
 * Centralized reactive store that owns all server communication and
 * internal event handling. Wraps ProjectStore for project/session state,
 * absorbs ActivityTracker for session activity, and handles WebSocket
 * events internally — views never participate in fetch/event decisions.
 *
 * Migration step 1: WS event handling + ActivityTracker merged in.
 * See docs/plans/reactive-store.md for the full plan.
 */

import { AppClient } from "./ws-client.js";
import { ProjectStore } from "./project-store.js";
import type { SessionData, SessionListItem, TaskListItem } from "./ws-client.js";
import type { ActivityState } from "./activity-tracker.js";

// Tools that modify files and should trigger a diff refresh
const FILE_MODIFYING_TOOLS = new Set(["write", "edit", "bash"]);

export type AppStoreListener = () => void;

export class AppStore {
  // ---- Delegates ------------------------------------------------------------

  private _projectStore = new ProjectStore();
  private _client: AppClient;

  // ---- Activity state (absorbed from ActivityTracker) -----------------------

  private _activityStates = new Map<string, ActivityState>();

  // ---- Connection state -----------------------------------------------------

  connected = false;

  // ---- Subscription ---------------------------------------------------------

  private _listeners = new Set<AppStoreListener>();
  private _unsubProjectStore: (() => void) | null = null;

  /**
   * Callback invoked when a diff refresh is needed.
   * Temporary bridge until step 2 (AppStore owns DiffStore).
   */
  onDiffRefreshNeeded: (() => void) | null = null;

  constructor(client: AppClient) {
    this._client = client;

    // Forward ProjectStore notifications to our subscribers
    this._unsubProjectStore = this._projectStore.subscribe(() => {
      this.notify();
    });

    // ---- WS event handling (moved from app.ts) ------------------------------

    client.onConnection((connected) => {
      this.connected = connected;
      this.notify();
      // On reconnect, re-fetch the active session to catch up on missed events
      if (connected && this._projectStore.sessionId) {
        this._projectStore.refreshSession();
      }
    });

    client.onEvent((sessionId, event) => {
      const store = this._projectStore;

      // Handle task_updated broadcast (not tagged with a sessionId)
      if (event.type === "task_updated" && event.projectId === store.projectId) {
        store.refreshLists();
        return;
      }

      // Track activity for all sessions
      if (sessionId && event.type === "agent_start") {
        this._setRunning(sessionId);
      } else if (sessionId && event.type === "agent_end") {
        this._setFinished(sessionId, store.sessionId);
        setTimeout(() => store.refreshLists(), 500);
      }

      // Only refresh diff for the session we're viewing
      if (sessionId !== store.sessionId) return;

      const refreshDiff =
        (event.type === "tool_execution_end" && FILE_MODIFYING_TOOLS.has(event.toolName)) ||
        event.type === "agent_end";

      if (refreshDiff) {
        setTimeout(() => this.onDiffRefreshNeeded?.(), 500);
      }
    });
  }

  // ---- ProjectStore delegate accessors --------------------------------------

  get projectId() { return this._projectStore.projectId; }
  get sessionId() { return this._projectStore.sessionId; }
  get tasks(): TaskListItem[] { return this._projectStore.tasks; }
  get sessions(): SessionListItem[] { return this._projectStore.sessions; }
  get sessionData(): SessionData | null { return this._projectStore.sessionData; }
  get loading() { return this._projectStore.loading; }

  // ---- Activity state accessors ---------------------------------------------

  /** Get the activity state for a session (undefined = normal/no activity). */
  getActivity(sessionId: string): ActivityState | undefined {
    return this._activityStates.get(sessionId);
  }

  /** Get a snapshot of all activity states (for passing as a property). */
  get activityMap(): Map<string, ActivityState> {
    return new Map(this._activityStates);
  }

  /** Summary counts for favicon/title. */
  get activitySummary(): { running: number; finished: number } {
    let running = 0;
    let finished = 0;
    for (const state of this._activityStates.values()) {
      if (state === "running") running++;
      else if (state === "finished") finished++;
    }
    return { running, finished };
  }

  /** Whether there's any activity at all. */
  get hasActivity(): boolean {
    return this._activityStates.size > 0;
  }

  // ---- Activity state mutations (private) -----------------------------------

  private _setRunning(sessionId: string): void {
    if (this._activityStates.get(sessionId) === "running") return;
    this._activityStates.set(sessionId, "running");
    this.notify();
  }

  private _setFinished(sessionId: string, activeSessionId: string): void {
    if (sessionId === activeSessionId) {
      this.clearActivity(sessionId);
      return;
    }
    this._activityStates.set(sessionId, "finished");
    this.notify();
  }

  /** Clear activity state for a session (e.g., user viewed it). */
  clearActivity(sessionId: string): void {
    if (!this._activityStates.has(sessionId)) return;
    this._activityStates.delete(sessionId);
    this.notify();
  }

  // ---- ProjectStore delegate methods ----------------------------------------

  async setRoute(
    projectId: number | null,
    sessionId: string | null,
  ): Promise<{ navigateTo: string } | null> {
    return this._projectStore.setRoute(projectId, sessionId);
  }

  async refreshLists() {
    return this._projectStore.refreshLists();
  }

  async refreshSession() {
    return this._projectStore.refreshSession();
  }

  async createSession(): Promise<string | null> {
    return this._projectStore.createSession();
  }

  async createTaskSession(
    taskId: number,
  ): Promise<{ sessionId: string } | { error: string }> {
    return this._projectStore.createTaskSession(taskId);
  }

  async updateTask(
    taskId: number,
    updates: { title?: string; description?: string | null },
  ): Promise<{ ok: true } | { error: string }> {
    return this._projectStore.updateTask(taskId, updates);
  }

  async deleteTask(taskId: number): Promise<{ ok: true } | { error: string }> {
    return this._projectStore.deleteTask(taskId);
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

  dispose() {
    this._unsubProjectStore?.();
    this._unsubProjectStore = null;
    this._listeners.clear();
  }
}

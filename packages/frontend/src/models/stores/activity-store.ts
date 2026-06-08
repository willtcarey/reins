/**
 * Activity Store
 *
 * Cross-project per-session notification state. ProjectsStore owns one
 * ActivityStore as the single source of truth for all session activity.
 * Maintains both a session-level map and a lightweight per-project summary.
 */

/** Activity state for a session/task: running, finished, or absent (no entry). */
export type ActivityState = "running" | "finished";

export interface ActivityFinishOptions {
  suppressUnread?: boolean;
}

export type ActivityStoreListener = () => void;

/** Merge two activity states: running wins over finished. */
function mergeActivity(a: ActivityState | undefined, b: ActivityState | undefined): ActivityState | undefined {
  if (a === "running" || b === "running") return "running";
  if (a === "finished" || b === "finished") return "finished";
  return undefined;
}

export class ActivityStore {
  private _activityStates = new Map<string, ActivityState>();
  private _activityMapCache: Map<string, ActivityState> | null = null;
  private _delegateSessions = new Set<string>();
  private _listeners = new Set<ActivityStoreListener>();

  /**
   * Maps session IDs to their project IDs. Maintained by applyServerState
   * and setProjectForSession. Used to derive per-project activity on the
   * fly from the single source of truth (_activityStates).
   */
  private _sessionProject = new Map<string, number>();

  subscribe(fn: ActivityStoreListener): () => void {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  private notify(): void {
    for (const fn of this._listeners) fn();
  }

  /** Get the activity state for a session (undefined = normal/no activity). */
  getActivity(sessionId: string): ActivityState | undefined {
    return this._activityStates.get(sessionId);
  }

  /** Snapshot of all activity states keyed by session id. */
  get activityMap(): Map<string, ActivityState> {
    if (!this._activityMapCache) {
      this._activityMapCache = new Map(this._activityStates);
    }
    return this._activityMapCache;
  }

  /** Session IDs currently marked as locally running. */
  get runningSessionIds(): string[] {
    const ids: string[] = [];
    for (const [sessionId, state] of this._activityStates) {
      if (state === "running") ids.push(sessionId);
    }
    return ids;
  }

  /** Summary counts for favicon/title aggregation. */
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

  /**
   * Activity state for a project header. Derived on the fly from
   * _activityStates + _sessionProject — no cached state to drift.
   */
  activityForProject(projectId: number): ActivityState | undefined {
    let result: ActivityState | undefined;
    for (const [sessionId, project] of this._sessionProject) {
      if (project !== projectId) continue;
      const state = this._activityStates.get(sessionId);
      result = mergeActivity(result, state);
    }
    return result;
  }

  trackDelegateSession(sessionId: string): void {
    this._delegateSessions.add(sessionId);
  }

  setRunning(sessionId: string): void {
    if (this._activityStates.get(sessionId) === "running") return;
    this._activityStates.set(sessionId, "running");
    this._activityMapCache = null;
    this.notify();
  }

  setFinished(sessionId: string, options: ActivityFinishOptions = {}): void {
    if (options.suppressUnread || this._delegateSessions.has(sessionId)) {
      const changed = this._deleteActivityState(sessionId);
      this._delegateSessions.delete(sessionId);
      if (changed) this.notify();
      return;
    }

    if (this._activityStates.get(sessionId) === "finished") return;

    this._activityStates.set(sessionId, "finished");
    this._activityMapCache = null;
    this.notify();
  }

  /**
   * Apply a server-authoritative activity state update (from DB or broadcast).
   * Synchronizes local state to match the server value. If a projectId is
   * provided, records the session→project mapping used to derive per-project
   * activity.
   */
  applyServerState(sessionId: string, serverState: "running" | "finished" | null, projectId?: number): void {
    const current = this._activityStates.get(sessionId);
    const next = serverState ?? undefined;
    if (current === next && projectId == null) return;

    if (serverState === null) {
      this._deleteActivityState(sessionId);
    } else {
      this._activityStates.set(sessionId, serverState);
      this._activityMapCache = null;
    }

    if (projectId != null) {
      this._sessionProject.set(sessionId, projectId);
    }

    this.notify();
  }

  /**
   * Record the project ID for a session. Used by WS event handlers so that
   * per-project activity can be derived from session-level state.
   */
  setProjectForSession(sessionId: string, projectId: number): void {
    this._sessionProject.set(sessionId, projectId);
  }

  /**
   * Mark a session as viewed by the user. Finished/unread activity is cleared,
   * but running activity stays visible until the agent loop ends.
   */
  markSessionViewed(sessionId: string): void {
    if (this._activityStates.get(sessionId) !== "finished") return;
    if (this._deleteActivityState(sessionId)) this.notify();
  }

  /** Force-clear activity state for a session. */
  clearActivity(sessionId: string): void {
    const changed = this._deleteActivityState(sessionId);
    this._delegateSessions.delete(sessionId);
    if (changed) this.notify();
  }

  clearSessions(sessionIds: Iterable<string>): void {
    let changed = false;
    for (const sessionId of sessionIds) {
      changed = this._deleteActivityState(sessionId) || changed;
      this._delegateSessions.delete(sessionId);
    }
    if (changed) this.notify();
  }

  private _deleteActivityState(sessionId: string): boolean {
    if (!this._activityStates.has(sessionId)) return false;
    this._activityStates.delete(sessionId);
    this._activityMapCache = null;
    return true;
  }
}

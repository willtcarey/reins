/**
 * Activity Store
 *
 * Project-scoped raw per-session notification state. ProjectStore owns one
 * ActivityStore and combines it with that project's task/session data for
 * UI-facing selectors and closed-task cleanup.
 */

/** Activity state for a session/task: running, finished, or absent (no entry). */
export type ActivityState = "running" | "finished";

export interface ActivityFinishOptions {
  suppressUnread?: boolean;
}

export type ActivityStoreListener = () => void;

export class ActivityStore {
  private _activityStates = new Map<string, ActivityState>();
  private _activityMapCache: Map<string, ActivityState> | null = null;
  private _delegateSessions = new Set<string>();
  private _listeners = new Set<ActivityStoreListener>();

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

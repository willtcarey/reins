/**
 * Activity Tracker
 *
 * Tracks session activity states for notification indicators.
 * Owned by app-shell, driven by WS events, consumed by sidebar components.
 *
 * States:
 *  - "running"  — agent is actively streaming
 *  - "finished" — agent completed, user hasn't viewed yet
 *  - (absent)   — no notable activity / already viewed
 */

export type ActivityState = "running" | "finished";

export type ActivityChangeListener = () => void;

export class ActivityTracker {
  private states = new Map<string, ActivityState>();
  private listeners = new Set<ActivityChangeListener>();

  /** Get the activity state for a session (undefined = normal/no activity). */
  get(sessionId: string): ActivityState | undefined {
    return this.states.get(sessionId);
  }

  /** Get a snapshot of all activity states (for passing as a property). */
  getAll(): Map<string, ActivityState> {
    return new Map(this.states);
  }

  /** Mark a session as running. */
  setRunning(sessionId: string): void {
    if (this.states.get(sessionId) === "running") return;
    this.states.set(sessionId, "running");
    this.notify();
  }

  /**
   * Mark a session as finished.
   * If `activeSessionId` matches, clear it instead (user is already viewing).
   */
  setFinished(sessionId: string, activeSessionId: string): void {
    if (sessionId === activeSessionId) {
      this.clear(sessionId);
      return;
    }
    this.states.set(sessionId, "finished");
    this.notify();
  }

  /** Clear activity state for a session (e.g., user viewed it). */
  clear(sessionId: string): void {
    if (!this.states.has(sessionId)) return;
    this.states.delete(sessionId);
    this.notify();
  }

  /** Summary counts for favicon/title. */
  get summary(): { running: number; finished: number } {
    let running = 0;
    let finished = 0;
    for (const state of this.states.values()) {
      if (state === "running") running++;
      else if (state === "finished") finished++;
    }
    return { running, finished };
  }

  /** Whether there's any activity at all. */
  get hasActivity(): boolean {
    return this.states.size > 0;
  }

  /** Subscribe to changes. Returns unsubscribe function. */
  onChange(listener: ActivityChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

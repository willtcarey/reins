/**
 * Project Store
 *
 * Holds the task collection and session list data for a single project. One instance per project,
 * lazily created by ProjectsStore.
 *
 * Activity state is NOT owned here — it lives in the shared SessionCache.
 * ProjectStore derives read-only activity selectors for rendering session-level dots.
 *
 * Components subscribe via `subscribe()` and read public state directly.
 */

import type { InjectedSkillInfo, SessionListItem } from "../ws-client.js";
import { TasksCollection, type TaskListItem } from "../tasks.js";
import type { ActivityState, SessionCache } from "./session-cache.js";

export type ProjectStoreListener = () => void;

export class ProjectStore {
  readonly projectId: number;

  // ---- Public reactive state ------------------------------------------------

  tasks: TasksCollection;
  sessions: SessionListItem[] = [];
  taskSessions: Map<number, SessionListItem[]> = new Map();
  skills: InjectedSkillInfo[] = [];
  loading = false;
  loaded = false;

  // ---- Private state --------------------------------------------------------

  private _sessionCache: SessionCache | null;
  private _sessionUnsubscribes = new Map<string, () => void>();
  private _listeners = new Set<ProjectStoreListener>();

  constructor(projectId: number, sessionCache: SessionCache | null = null) {
    this.projectId = projectId;
    this._sessionCache = sessionCache;
    this.tasks = TasksCollection.empty(projectId);
  }

  // ---- Subscription ---------------------------------------------------------

  subscribe(fn: ProjectStoreListener): () => void {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  private notify() {
    for (const fn of this._listeners) fn();
  }

  dispose(): void {
    for (const unsubscribe of this._sessionUnsubscribes.values()) unsubscribe();
    this._sessionUnsubscribes.clear();
  }

  // ---- Activity selectors (read-only) --------------------------------------

  /** Activity states for sessions in this project. */
  get activityMap(): Map<string, ActivityState> {
    return new Map(
      (this._sessionCache?.entries() ?? []).flatMap((session) =>
        session.projectId === this.projectId && session.activityState
          ? [[session.id, session.activityState] as const]
          : []
      ),
    );
  }

  get tasksWithActivity(): TasksCollection {
    return this.tasks.withActivity(this.activityMap);
  }

  get activitySummary(): { running: number; finished: number } {
    let running = 0;
    let finished = 0;
    for (const session of this._sessionCache?.entries() ?? []) {
      if (session.projectId !== this.projectId) continue;
      if (session.activityState === "running") running++;
      else if (session.activityState === "finished") finished++;
    }
    return { running, finished };
  }

  activityForSession(sessionId: string): ActivityState {
    return this._sessionCache?.get(sessionId)?.activityState ?? null;
  }

  /** Derive the project-level activity state from SessionCache project metadata. */
  get activityState(): ActivityState {
    const states = (this._sessionCache?.entries() ?? [])
      .filter((session) => session.projectId === this.projectId)
      .map((session) => session.activityState);

    if (states.includes("running")) return "running";
    if (states.includes("finished")) return "finished";
    return null;
  }

  // ---- Actions --------------------------------------------------------------

  /**
   * Fetch tasks and sessions for this project in parallel.
   */
  async fetchLists(): Promise<void> {
    this.loading = true;
    this.notify();

    try {
      const [tasksResp, sessionsResp, skillsResp] = await Promise.all([
        fetch(`/api/projects/${this.projectId}/tasks`),
        fetch(`/api/projects/${this.projectId}/sessions`),
        fetch(`/api/projects/${this.projectId}/skills`),
      ]);

      if (tasksResp.ok) {
        const tasks: TaskListItem[] = await tasksResp.json();
        this.tasks = new TasksCollection(this.projectId, tasks);
      }
      if (sessionsResp.ok) {
        const sessions: SessionListItem[] = await sessionsResp.json();
        this.sessions = sessions;
        this.reconcileSessionSubscriptions();
        this._sessionCache?.setMany(sessions);
      }
      if (skillsResp.ok) {
        const body = await skillsResp.json().catch(() => null);
        this.skills = Array.isArray(body?.skills) ? body.skills : [];
      }
      if (this.taskSessions.size > 0) {
        await Promise.all(
          [...this.taskSessions.keys()].map((taskId) => this.fetchTaskSessions(taskId)),
        );
      }
      this.loaded = true;
    } catch {
      // silent — leave loaded as-is (false if first attempt)
    }

    this.loading = false;
    this.notify();
  }

  /** Update a task's title and/or description. */
  async updateTask(
    taskId: number,
    updates: { title?: string; description?: string | null },
  ): Promise<{ ok: true } | { error: string }> {
    try {
      const resp = await fetch(
        `/api/projects/${this.projectId}/tasks/${taskId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(updates),
        },
      );
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        return { error: body.error || `HTTP ${resp.status}` };
      }
      return { ok: true };
    } catch {
      return { error: "Network error" };
    }
  }

  /** Delete a task. */
  async deleteTask(taskId: number): Promise<{ ok: true } | { error: string }> {
    try {
      const resp = await fetch(
        `/api/projects/${this.projectId}/tasks/${taskId}`,
        { method: "DELETE" },
      );
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        return { error: body.error || `HTTP ${resp.status}` };
      }
      return { ok: true };
    } catch {
      return { error: "Network error" };
    }
  }

  /** Generate a task from a freeform prompt. */
  async generateTask(prompt: string): Promise<{ ok: true } | { error: string }> {
    try {
      const resp = await fetch(
        `/api/projects/${this.projectId}/tasks/generate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt }),
        },
      );
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        return { error: body.error || `Error creating task (HTTP ${resp.status})` };
      }
      return { ok: true };
    } catch {
      return { error: "Network error" };
    }
  }

  /**
   * Fetch the list of skills available for tab-completion.
   * Safe to call repeatedly; updates the `skills` field and notifies subscribers.
   */
  async fetchSkills(): Promise<void> {
    try {
      const resp = await fetch(`/api/projects/${this.projectId}/skills`);
      if (!resp.ok) return;
      const body = await resp.json();
      const skills: InjectedSkillInfo[] = Array.isArray(body.skills) ? body.skills : [];
      this.skills = skills;
      this.notify();
    } catch {
      // silent — skill autocomplete is best-effort
    }
  }

  /**
   * Fetch sessions for a specific task (for expanded task sublists).
   * Skips notification if data hasn't changed.
   */
  async fetchTaskSessions(taskId: number): Promise<void> {
    try {
      const resp = await fetch(
        `/api/tasks/${taskId}/sessions`,
      );
      if (resp.ok) {
        const sessions: SessionListItem[] = await resp.json();
        // Skip update if data hasn't changed
        const existing = this.taskSessions.get(taskId);
        if (existing && JSON.stringify(existing) === JSON.stringify(sessions)) {
          return;
        }
        const next = new Map(this.taskSessions);
        next.set(taskId, sessions);
        this.taskSessions = next;
        this.reconcileSessionSubscriptions();
        this._sessionCache?.setMany(sessions);
        this.notify();
      }
    } catch {
      // silent
    }
  }

  private reconcileSessionSubscriptions(): void {
    if (!this._sessionCache) return;

    const nextSessionIds = new Set<string>();
    for (const session of this.sessions) nextSessionIds.add(session.id);
    for (const sessions of this.taskSessions.values()) {
      for (const session of sessions) nextSessionIds.add(session.id);
    }

    for (const [sessionId, unsubscribe] of this._sessionUnsubscribes) {
      if (nextSessionIds.has(sessionId)) continue;
      unsubscribe();
      this._sessionUnsubscribes.delete(sessionId);
    }

    for (const sessionId of nextSessionIds) {
      if (this._sessionUnsubscribes.has(sessionId)) continue;
      const unsubscribe = this._sessionCache.subscribe(sessionId, () => this.notify());
      this._sessionUnsubscribes.set(sessionId, unsubscribe);
    }
  }
}

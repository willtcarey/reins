/**
 * Project Store
 *
 * Holds the task collection and session list data for a single project. One instance per project,
 * lazily created by ProjectsStore.
 *
 * Components subscribe via `subscribe()` and read public state directly.
 */

import type { InjectedSkillInfo, SessionListItem } from "../ws-client.js";
import { TasksCollection, type TaskListItem } from "../tasks.js";
import { ActivityStore, type ActivityFinishOptions, type ActivityState } from "./activity-store.js";

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

  private _activity = new ActivityStore();
  private _listeners = new Set<ProjectStoreListener>();

  constructor(projectId: number) {
    this.projectId = projectId;
    this.tasks = TasksCollection.empty(projectId);
    this._activity.subscribe(() => this.notify());
  }

  // ---- Subscription ---------------------------------------------------------

  subscribe(fn: ProjectStoreListener): () => void {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  private notify() {
    for (const fn of this._listeners) fn();
  }

  // ---- Activity selectors/actions ------------------------------------------

  get activityMap(): Map<string, ActivityState> {
    return this._activity.activityMap;
  }

  get tasksWithActivity(): TasksCollection {
    return this.tasks.withActivity(this.activityMap);
  }

  get activitySummary(): { running: number; finished: number } {
    return this._activity.activitySummary;
  }

  activityForSession(sessionId: string): ActivityState | undefined {
    return this._activity.getActivity(sessionId);
  }

  trackDelegateSession(sessionId: string): void {
    this._activity.trackDelegateSession(sessionId);
  }

  markSessionViewed(sessionId: string): void {
    this._activity.markSessionViewed(sessionId);
  }

  get activityState(): ActivityState | undefined {
    let hasFinished = false;
    const merge = (state: ActivityState | undefined) => {
      if (state === "running") return true;
      if (state === "finished") hasFinished = true;
      return false;
    };

    for (const state of this.tasksWithActivity.activityByTask.values()) {
      if (merge(state)) return "running";
    }

    for (const session of this.sessions) {
      if (merge(this.activityMap.get(session.id))) return "running";
    }

    for (const [sessionId, state] of this.activityMap) {
      if (this.tasks.hasClosedTaskSession(sessionId)) continue;
      if (merge(state)) return "running";
    }

    return hasFinished ? "finished" : undefined;
  }

  markSessionRunning(sessionId: string): void {
    if (this.tasks.hasClosedTaskSession(sessionId)) {
      this._activity.clearActivity(sessionId);
      return;
    }
    this._activity.setRunning(sessionId);
  }

  markSessionFinished(sessionId: string, options: ActivityFinishOptions = {}): void {
    if (this.tasks.hasClosedTaskSession(sessionId)) {
      this._activity.clearActivity(sessionId);
      return;
    }
    this._activity.setFinished(sessionId, options);
  }

  clearActivityForClosedTasks(): void {
    this._activity.clearSessions(this.tasks.closedTaskSessionIds);
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
      if (sessionsResp.ok) this.sessions = await sessionsResp.json();
      if (skillsResp.ok) {
        const body = await skillsResp.json().catch(() => null);
        this.skills = Array.isArray(body?.skills) ? body.skills : [];
      }
      if (this.taskSessions.size > 0) {
        await Promise.all(
          [...this.taskSessions.keys()].map((taskId) => this.fetchTaskSessions(taskId)),
        );
      }
      this.clearActivityForClosedTasks();
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
        this.notify();
      }
    } catch {
      // silent
    }
  }
}

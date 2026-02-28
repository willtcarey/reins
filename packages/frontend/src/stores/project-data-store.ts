/**
 * Project Data Store
 *
 * Holds task/session list data for a single project. One instance per project,
 * lazily created by MultiProjectStore. This is the per-project equivalent of
 * the list-fetching parts of ActiveProjectStore, without session detail data
 * or route handling.
 *
 * Components subscribe via `subscribe()` and read public state directly.
 */

import type { SessionListItem, TaskListItem } from "../ws-client.js";

export type ProjectDataStoreListener = () => void;

export class ProjectDataStore {
  readonly projectId: number;

  // ---- Public reactive state ------------------------------------------------

  tasks: TaskListItem[] = [];
  sessions: SessionListItem[] = [];
  taskSessions: Map<number, SessionListItem[]> = new Map();
  loading = false;
  loaded = false;

  // ---- Private state --------------------------------------------------------

  private _listeners = new Set<ProjectDataStoreListener>();

  constructor(projectId: number) {
    this.projectId = projectId;
  }

  // ---- Subscription ---------------------------------------------------------

  subscribe(fn: ProjectDataStoreListener): () => void {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  private notify() {
    for (const fn of this._listeners) fn();
  }

  // ---- Actions --------------------------------------------------------------

  /**
   * Fetch tasks and sessions for this project in parallel.
   */
  async fetchLists(): Promise<void> {
    this.loading = true;
    this.notify();

    try {
      const [tasksResp, sessionsResp] = await Promise.all([
        fetch(`/api/projects/${this.projectId}/tasks`),
        fetch(`/api/projects/${this.projectId}/sessions`),
      ]);

      if (tasksResp.ok) this.tasks = await tasksResp.json();
      if (sessionsResp.ok) this.sessions = await sessionsResp.json();
      this.loaded = true;
    } catch {
      // silent — leave loaded as-is (false if first attempt)
    }

    this.loading = false;
    this.notify();
  }

  /**
   * Fetch sessions for a specific task (for expanded task sublists).
   * Skips notification if data hasn't changed.
   */
  async fetchTaskSessions(taskId: number): Promise<void> {
    try {
      const resp = await fetch(
        `/api/projects/${this.projectId}/tasks/${taskId}/sessions`,
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

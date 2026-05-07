/**
 * Project task collection model.
 *
 * Owns the frontend task list row type plus project-scoped selectors that
 * derive task-level notification state from raw per-session activity.
 */

export type TaskStatus = "open" | "closed";

export interface TaskListItem {
  id: number;
  project_id: number;
  title: string;
  description: string | null;
  branch_name: string;
  status: TaskStatus;
  created_at: string;
  updated_at: string;
  session_count: number;
  session_ids: string[];
  diffStats: { additions: number; removals: number } | null;
}

/** Activity state for a session/task: running, finished, or absent (no entry). */
export type ActivityState = "running" | "finished";

/**
 * Project-specific task collection plus task notification selectors.
 *
 * The collection is intentionally immutable from the model's perspective:
 * callers provide the latest task array and session activity map, and derived
 * properties are recalculated from those snapshots.
 */
export class TasksCollection {
  static empty(projectId: number | null = null): TasksCollection {
    return new TasksCollection(projectId, [], new Map());
  }

  constructor(
    readonly projectId: number | null,
    readonly items: readonly TaskListItem[],
    private readonly sessionActivity: ReadonlyMap<string, ActivityState> = new Map(),
  ) {}

  withActivity(sessionActivity: ReadonlyMap<string, ActivityState>): TasksCollection {
    return new TasksCollection(this.projectId, this.items, sessionActivity);
  }

  get open(): TaskListItem[] {
    return this.items.filter((task) => task.status !== "closed");
  }

  get closed(): TaskListItem[] {
    return this.items.filter((task) => task.status === "closed");
  }

  get activityByTask(): Map<number, ActivityState> {
    const result = new Map<number, ActivityState>();
    for (const task of this.items) {
      const activity = this.activityFor(task);
      if (activity) result.set(task.id, activity);
    }
    return result;
  }

  get closedTaskSessionIds(): Set<string> {
    const ids = new Set<string>();
    for (const task of this.items) {
      if (task.status !== "closed") continue;
      for (const sessionId of task.session_ids) {
        ids.add(sessionId);
      }
    }
    return ids;
  }

  find(taskId: number): TaskListItem | undefined {
    return this.items.find((task) => task.id === taskId);
  }

  findBySessionId(sessionId: string): TaskListItem | undefined {
    return this.items.find((task) => task.session_ids.includes(sessionId));
  }

  activityFor(task: Pick<TaskListItem, "status" | "session_ids">): ActivityState | undefined {
    if (task.status === "closed") return undefined;
    if (!task.session_ids.length) return undefined;

    let hasFinished = false;
    for (const sessionId of task.session_ids) {
      const state = this.sessionActivity.get(sessionId);
      if (state === "running") return "running";
      if (state === "finished") hasFinished = true;
    }
    return hasFinished ? "finished" : undefined;
  }

  activityForId(taskId: number): ActivityState | undefined {
    const task = this.find(taskId);
    return task ? this.activityFor(task) : undefined;
  }

  hasClosedTaskSession(sessionId: string): boolean {
    return this.items.some((task) =>
      task.status === "closed" && task.session_ids.includes(sessionId)
    );
  }
}

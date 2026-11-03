/**
 * Project Tasks
 *
 * Business logic for task lifecycle: creation, listing, update, and deletion.
 * Orchestrates store calls, branch-name derivation, the checkout's git (diff stats, deleting a branch)
 * and WebSocket broadcasts. A task's branch is made where its sessions work, by their runs
 * (`prepareCheckout`), not here.
 *
 * Accessed via `ProjectModel.tasks()` — not constructed directly by callers.
 */

import {
  createTask,
  listTasks,
  getTask as storeGetTask,
  updateTask as storeUpdateTask,
  setTaskStatus,
  deleteTask as storeDeleteTask,
  getTaskSessionIds,
  projectHasTaskBranch,
  type TaskRow,
  type TaskListItem,
  type TaskListOptions,
  type TaskStatus,
} from "../task-store.js";
import { clearFinishedActivityForTasks, getSession } from "../session-store.js";
import { slugifyBranchName } from "../branch-name.js";
import type { Git, DiffStats } from "../git.js";
import type { Broadcast } from "./broadcast.js";
import type { Nodes } from "./nodes.js";
import { logger } from "../logger.js";
import { sessionActivity } from "./session-activity.js";
import type { ServerProcess } from "../state.js";
import { closeSessionRuntimes } from "../session-runtime/live.js";

// ---------------------------------------------------------------------------
// Domain errors
// ---------------------------------------------------------------------------

export class TaskNotFoundError extends Error {
  constructor(message = "Task not found") { super(message); }
}

export class TaskHasActiveSessionsError extends Error {
  readonly activeCount: number;
  constructor(count: number) {
    super(`Cannot delete task: ${count} session(s) are currently running`);
    this.activeCount = count;
  }
}

export interface CreateTaskParams {
  title: string;
  description: string;
  branch_name?: string;
}

export interface TaskWithDiffStats extends TaskListItem {
  diffStats: DiffStats | null;
}

// ---------------------------------------------------------------------------
// ProjectTasks
// ---------------------------------------------------------------------------

export class ProjectTasks {
  constructor(
    private projectId: number,
    private git: Git,
    private baseBranch: string,
    private nodes: Nodes,
  ) {}

  private get broadcast(): Broadcast { return this.nodes.broadcast; }

  /**
   * Create a task and broadcast it. Touches no checkout: its branch is made by its sessions' runs where
   * they work (`TaskBranch`), adopting one that exists there or on origin. A name derived from the title
   * that another of the project's tasks has gets a suffix; a name given is kept, to adopt that branch.
   */
  async create(params: CreateTaskParams): Promise<TaskRow> {
    const given = params.branch_name?.trim();
    let branchName = given || slugifyBranchName(params.title);
    if (!given && projectHasTaskBranch(this.projectId, branchName)) branchName = `${branchName}-${Date.now().toString(36).slice(-4)}`;

    const task = createTask(this.projectId, params.title.trim(), params.description?.trim() || null, branchName);
    this.broadcast({ type: "task_updated", projectId: this.projectId });
    return task;
  }

  /**
   * Get a single task by ID. Returns null if not found or doesn't belong to this project.
   */
  get(taskId: number): TaskRow | null {
    const task = storeGetTask(taskId);
    if (!task || task.project_id !== this.projectId) return null;
    return task;
  }

  /**
   * List tasks for a project, optionally filtered by status.
   * Open tasks appear before closed ones, ordered by most recent update.
   */
  list(status?: TaskStatus): TaskListItem[] {
    return listTasks(this.projectId, status);
  }

  /**
   * List tasks for a project, optionally filtered by status, enriching open ones with diff stats.
   *
   * Per-task errors (e.g. missing branch) are swallowed — the task is
   * returned with `diffStats: null`.
   */
  async listWithDiffStats(
    status?: TaskStatus,
    options: TaskListOptions = {},
  ): Promise<TaskWithDiffStats[]> {
    const tasks = listTasks(this.projectId, status, options);

    return Promise.all(
      tasks.map(async (task) => {
        if (task.status !== "open") {
          return { ...task, diffStats: null };
        }
        try {
          const diffStats = await this.git.getDiffStats(task.branch_name, this.baseBranch);
          return { ...task, diffStats };
        } catch {
          return { ...task, diffStats: null };
        }
      }),
    );
  }

  /**
   * Update a task's title/description and broadcast the change.
   *
   * Returns the updated row, or null if the task doesn't exist.
   */
  update(taskId: number, updates: { title?: string; description?: string | null; base_commit?: string }): TaskRow | null {
    if (!this.get(taskId)) return null;
    const updated = storeUpdateTask(taskId, updates);
    if (updated) {
      this.broadcast({ type: "task_updated", projectId: this.projectId });
    }
    return updated;
  }

  /**
   * Close an open task and broadcast the change.
   * Throws if the task doesn't exist.
   */
  close(taskId: number): TaskRow {
    if (!this.get(taskId)) throw new TaskNotFoundError();
    const task = setTaskStatus(taskId, "closed");
    if (!task) throw new TaskNotFoundError();
    const clearedFinishedSessionIds = clearFinishedActivityForTasks([taskId]);
    this.broadcast({ type: "task_updated", projectId: this.projectId });
    for (const sessionId of clearedFinishedSessionIds) {
      this.broadcast({
        type: "session_updated",
        sessionId,
        projectId: this.projectId,
      });
    }
    return task;
  }

  /**
   * Reopen a closed task and broadcast the change. A branch deleted meanwhile is made again by its next
   * session's run. Throws if the task doesn't exist.
   */
  reopen(taskId: number): TaskRow {
    if (!this.get(taskId)) throw new TaskNotFoundError();
    const task = setTaskStatus(taskId, "open");
    if (!task) throw new TaskNotFoundError();
    this.broadcast({ type: "task_updated", projectId: this.projectId });
    return task;
  }

  /**
   * Delete a task, its sessions/messages, and remove the git branch. The counterpart to `create`.
   *
   * Throws if the task doesn't exist, doesn't belong to the project,
   * or has active sessions (`sessionActivity`). The sessions' live runtimes (`serverProcess`'s) are closed
   * before their rows go.
   */
  async delete(taskId: number, serverProcess: ServerProcess): Promise<void> {
    const task = this.get(taskId);
    if (!task) throw new TaskNotFoundError();

    const sessionIds = getTaskSessionIds(taskId);
    const activeSessions = sessionIds.filter((sid) => {
      const row = getSession(sid);
      return !!row && sessionActivity(row, serverProcess.sessions) !== "idle";
    });
    if (activeSessions.length > 0) {
      throw new TaskHasActiveSessionsError(activeSessions.length);
    }
    await closeSessionRuntimes(serverProcess, sessionIds);

    // Delete task (cascades sessions + messages in DB)
    const sources = this.nodes.watchSources();
    storeDeleteTask(taskId);
    sources.publishChanged();
    this.broadcast({ type: "task_updated", projectId: this.projectId });

    // Delete the git branch (best-effort — may fail if checked out)
    try {
      const currentBranch = await this.git.getCurrentBranch();
      if (currentBranch === task.branch_name) {
        await this.git.checkoutBranch(this.baseBranch);
      }
      await this.git.deleteBranch(task.branch_name);
    } catch (err: any) {
      logger.warn(`  Could not delete branch ${task.branch_name}: ${err.message}`);
    }
  }
}

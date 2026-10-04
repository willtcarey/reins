/**
 * Project Tasks
 *
 * Business logic for task lifecycle: creation, listing, update, and deletion.
 * Orchestrates store calls, git operations, branch-name derivation, and
 * WebSocket broadcasts.
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
  type TaskRow,
  type TaskListItem,
  type TaskListOptions,
  type TaskStatus,
} from "../task-store.js";
import { clearFinishedActivityForTasks, getSession } from "../session-store.js";
import { slugifyBranchName } from "../task-generator.js";
import type { Git, DiffStats } from "../git.js";
import type { Broadcast } from "./broadcast.js";
import { logger } from "../logger.js";
import { sessionActivity } from "../sessions/session-runs.js";

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
    private broadcast: Broadcast,
  ) {}

  /**
   * Create a task with a dedicated git branch and broadcast the result.
   *
   * When `branch_name` is explicitly provided and the branch already exists
   * (locally or on origin), it is adopted — no new branch is created, and the
   * `base_commit` is set to the merge-base of the base branch and the
   * existing branch. This supports the "pull someone else's branch" workflow.
   *
   * When `branch_name` is derived from the title, collisions get a suffix
   * (to avoid silently adopting an unrelated branch).
   *
   * Throws on failure — callers handle errors in their own way.
   */
  async create(params: CreateTaskParams): Promise<TaskRow> {
    const explicitBranch = !!params.branch_name?.trim();
    let branchName = params.branch_name?.trim() || slugifyBranchName(params.title);
    let baseCommit: string;

    if (explicitBranch && await this.git.branchExists(branchName)) {
      // Adopt existing local branch
      baseCommit = await this.git.mergeBase(this.baseBranch, branchName);
    } else if (explicitBranch && !await this.git.branchExists(branchName)) {
      // Try fetching from origin
      await this.git.fetchOrigin(branchName);
      if (await this.git.remoteBranchExists(branchName)) {
        // Adopt remote branch
        await this.git.trackBranch(branchName);
        baseCommit = await this.git.mergeBase(this.baseBranch, branchName);
      } else {
        // Branch doesn't exist anywhere — create it
        await this.git.createBranch(branchName, this.baseBranch);
        baseCommit = await this.git.revParse(this.baseBranch);
      }
    } else {
      // Derived branch name — collision suffix behavior
      if (await this.git.branchExists(branchName)) {
        const suffix = Date.now().toString(36).slice(-4);
        branchName = `${branchName}-${suffix}`;
      }
      await this.git.createBranch(branchName, this.baseBranch);
      baseCommit = await this.git.revParse(this.baseBranch);
    }

    const task = createTask(this.projectId, params.title.trim(), params.description?.trim() || null, branchName, baseCommit);
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
   * Reopen a closed task and broadcast the change.
   * Recreates the git branch if it was cleaned up during close.
   * Throws if the task doesn't exist.
   */
  async reopen(taskId: number): Promise<TaskRow> {
    if (!this.get(taskId)) throw new TaskNotFoundError();
    const task = setTaskStatus(taskId, "open");
    if (!task) throw new TaskNotFoundError();

    // Recreate the branch if it was deleted during reconciliation,
    // starting from the current base branch tip and updating base_commit.
    const exists = await this.git.branchExists(task.branch_name);
    if (!exists) {
      await this.git.createBranch(task.branch_name, this.baseBranch);
      const newBase = await this.git.revParse(this.baseBranch);
      const updated = storeUpdateTask(taskId, { base_commit: newBase });
      this.broadcast({ type: "task_updated", projectId: this.projectId });
      return updated ?? task;
    }

    this.broadcast({ type: "task_updated", projectId: this.projectId });
    return task;
  }

  /**
   * Delete a task, its sessions/messages, and remove the git branch. The counterpart to `create`.
   *
   * Throws if the task doesn't exist, doesn't belong to the project,
   * or has active sessions (running, or with queued input, on their node).
   */
  async delete(taskId: number): Promise<void> {
    const task = this.get(taskId);
    if (!task) throw new TaskNotFoundError();

    const activeSessions = getTaskSessionIds(taskId).filter((sid) => {
      const row = getSession(sid);
      return !!row && sessionActivity(row) !== "idle";
    });
    if (activeSessions.length > 0) {
      throw new TaskHasActiveSessionsError(activeSessions.length);
    }

    // Delete task (cascades sessions + messages in DB)
    storeDeleteTask(taskId);
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

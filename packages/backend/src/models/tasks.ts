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
  type TaskStatus,
} from "../task-store.js";
import { slugifyBranchName } from "../branch-namer.js";
import {
  branchExists,
  createBranch,
  revParse,
  getDiffStats,
  getCurrentBranch,
  checkoutBranch,
  deleteBranch,
  mergeBase,
  fetchOrigin,
  remoteBranchExists,
  trackBranch,
  type DiffStats,
} from "../git.js";
import type { Broadcast } from "./broadcast.js";
import type { ManagedSession } from "../state.js";

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
    private projectDir: string,
    private baseBranch: string,
    private sessions: Map<string, ManagedSession>,
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

    if (explicitBranch && await branchExists(this.projectDir, branchName)) {
      // Adopt existing local branch
      baseCommit = await mergeBase(this.projectDir, this.baseBranch, branchName);
    } else if (explicitBranch && !await branchExists(this.projectDir, branchName)) {
      // Try fetching from origin
      await fetchOrigin(this.projectDir, branchName);
      if (await remoteBranchExists(this.projectDir, branchName)) {
        // Adopt remote branch
        await trackBranch(this.projectDir, branchName);
        baseCommit = await mergeBase(this.projectDir, this.baseBranch, branchName);
      } else {
        // Branch doesn't exist anywhere — create it
        await createBranch(this.projectDir, branchName, this.baseBranch);
        baseCommit = await revParse(this.projectDir, this.baseBranch);
      }
    } else {
      // Derived branch name — collision suffix behavior
      if (await branchExists(this.projectDir, branchName)) {
        const suffix = Date.now().toString(36).slice(-4);
        branchName = `${branchName}-${suffix}`;
      }
      await createBranch(this.projectDir, branchName, this.baseBranch);
      baseCommit = await revParse(this.projectDir, this.baseBranch);
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
   * List all tasks for a project, enriching open ones with diff stats.
   *
   * Per-task errors (e.g. missing branch) are swallowed — the task is
   * returned with `diffStats: null`.
   */
  async listWithDiffStats(): Promise<TaskWithDiffStats[]> {
    const tasks = listTasks(this.projectId);

    return Promise.all(
      tasks.map(async (task) => {
        if (task.status !== "open") {
          return { ...task, diffStats: null };
        }
        try {
          const diffStats = await getDiffStats(this.projectDir, task.branch_name, this.baseBranch);
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
  update(taskId: number, updates: { title?: string; description?: string }): TaskRow | null {
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
    this.broadcast({ type: "task_updated", projectId: this.projectId });
    return task;
  }

  /**
   * Reopen a closed task and broadcast the change.
   * Throws if the task doesn't exist.
   */
  reopen(taskId: number): TaskRow {
    if (!this.get(taskId)) throw new TaskNotFoundError();
    const task = setTaskStatus(taskId, "open");
    if (!task) throw new TaskNotFoundError();
    this.broadcast({ type: "task_updated", projectId: this.projectId });
    return task;
  }

  /**
   * Delete a task, its sessions/messages, clean up in-memory sessions,
   * and remove the git branch. The counterpart to `create`.
   *
   * Throws if the task doesn't exist, doesn't belong to the project,
   * or has active streaming sessions.
   */
  async delete(taskId: number): Promise<void> {
    const task = this.get(taskId);
    if (!task) throw new TaskNotFoundError();

    // Check for active (in-memory, streaming) sessions
    const sessionIds = getTaskSessionIds(taskId);
    const activeSessions: string[] = [];
    for (const sid of sessionIds) {
      const managed = this.sessions.get(sid);
      if (!managed) continue;
      if (managed.runtime.isStreaming()) {
        activeSessions.push(sid);
      }
    }
    if (activeSessions.length > 0) {
      throw new TaskHasActiveSessionsError(activeSessions.length);
    }

    // Remove in-memory sessions for this task
    for (const sid of sessionIds) {
      this.sessions.delete(sid);
    }

    // Delete task (cascades sessions + messages in DB)
    storeDeleteTask(taskId);
    this.broadcast({ type: "task_updated", projectId: this.projectId });

    // Delete the git branch (best-effort — may fail if checked out)
    try {
      const currentBranch = await getCurrentBranch(this.projectDir);
      if (currentBranch === task.branch_name) {
        await checkoutBranch(this.projectDir, this.baseBranch);
      }
      await deleteBranch(this.projectDir, task.branch_name);
    } catch (err: any) {
      console.warn(`  Could not delete branch ${task.branch_name}: ${err.message}`);
    }
  }
}

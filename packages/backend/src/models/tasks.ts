/**
 * Task Model
 *
 * Business logic for task lifecycle: creation, listing, update, and deletion.
 * Orchestrates store calls, git operations, branch-name derivation, and
 * WebSocket broadcasts.
 *
 * Routes and tools call into this layer rather than duplicating the sequence.
 */

import {
  createTask,
  listTasks,
  getTask,
  updateTask as storeUpdateTask,
  deleteTask as storeDeleteTask,
  getTaskSessionIds,
  type TaskRow,
  type TaskListItem,
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

/**
 * Create a task with a dedicated git branch and broadcast the result.
 *
 * 1. Derive branch_name from title if not provided.
 * 2. Check for branch collision; append suffix if needed.
 * 3. Create the git branch from baseBranch.
 * 4. Capture the base branch SHA for merge reconciliation.
 * 5. Insert the task row.
 * 6. Broadcast `task_updated` to all WS clients.
 * 7. Return the created TaskRow.
 *
 * Throws on failure — callers handle errors in their own way.
 */
export async function createTaskWithBranch(
  projectId: number,
  projectDir: string,
  baseBranch: string,
  params: CreateTaskParams,
  broadcast: Broadcast,
): Promise<TaskRow> {
  // 1. Derive branch name
  let branchName = params.branch_name?.trim() || slugifyBranchName(params.title);

  // 2. Check for collision; append suffix if needed
  if (await branchExists(projectDir, branchName)) {
    const suffix = Date.now().toString(36).slice(-4);
    branchName = `${branchName}-${suffix}`;
  }

  // 3. Create git branch
  await createBranch(projectDir, branchName, baseBranch);

  // 4. Capture the base branch SHA so reconciliation can distinguish
  //    "never committed" from "genuinely merged" later.
  const baseCommit = await revParse(projectDir, baseBranch);

  // 5. Insert task row
  const task = createTask(projectId, params.title.trim(), params.description?.trim() || null, branchName, baseCommit);

  // 6. Broadcast
  broadcast({ type: "task_updated", projectId });

  return task;
}

// ---------------------------------------------------------------------------
// List tasks with diff stats (#2)
// ---------------------------------------------------------------------------

export interface TaskWithDiffStats extends TaskListItem {
  diffStats: DiffStats | null;
}

/**
 * List all tasks for a project, enriching open ones with diff stats.
 *
 * Per-task errors (e.g. missing branch) are swallowed — the task is
 * returned with `diffStats: null`.
 */
export async function listTasksWithDiffStats(
  projectId: number,
  projectDir: string,
  baseBranch: string,
): Promise<TaskWithDiffStats[]> {
  const tasks = listTasks(projectId);

  return Promise.all(
    tasks.map(async (task) => {
      if (task.status !== "open") {
        return { ...task, diffStats: null };
      }
      try {
        const diffStats = await getDiffStats(projectDir, task.branch_name, baseBranch);
        return { ...task, diffStats };
      } catch {
        return { ...task, diffStats: null };
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// Update task + broadcast (#3)
// ---------------------------------------------------------------------------

/**
 * Update a task's title/description and broadcast the change.
 *
 * Returns the updated row, or null if the task doesn't exist.
 */
export function updateTaskAndBroadcast(
  taskId: number,
  projectId: number,
  updates: { title?: string; description?: string },
  broadcast: Broadcast,
): TaskRow | null {
  const updated = storeUpdateTask(taskId, updates);
  if (updated) {
    broadcast({ type: "task_updated", projectId });
  }
  return updated;
}

// ---------------------------------------------------------------------------
// Delete task with branch cleanup (#4)
// ---------------------------------------------------------------------------

/**
 * Delete a task, its sessions/messages, clean up in-memory sessions,
 * and remove the git branch. The counterpart to `createTaskWithBranch`.
 *
 * Throws if the task doesn't exist, doesn't belong to the project,
 * or has active streaming sessions.
 */
export async function deleteTaskWithBranch(
  taskId: number,
  projectId: number,
  projectDir: string,
  baseBranch: string,
  sessions: Map<string, ManagedSession>,
  broadcast: Broadcast,
): Promise<void> {
  const task = getTask(taskId);
  if (!task || task.project_id !== projectId) {
    throw new TaskNotFoundError();
  }

  // Check for active (in-memory, streaming) sessions
  const sessionIds = getTaskSessionIds(taskId);
  const activeSessions: string[] = [];
  for (const sid of sessionIds) {
    const managed = sessions.get(sid);
    if (managed && managed.session.isStreaming) {
      activeSessions.push(sid);
    }
  }
  if (activeSessions.length > 0) {
    throw new TaskHasActiveSessionsError(activeSessions.length);
  }

  // Remove in-memory sessions for this task
  for (const sid of sessionIds) {
    sessions.delete(sid);
  }

  // Delete task (cascades sessions + messages in DB)
  storeDeleteTask(taskId);
  broadcast({ type: "task_updated", projectId });

  // Delete the git branch (best-effort — may fail if checked out)
  try {
    const currentBranch = await getCurrentBranch(projectDir);
    if (currentBranch === task.branch_name) {
      await checkoutBranch(projectDir, baseBranch);
    }
    await deleteBranch(projectDir, task.branch_name);
  } catch (err: any) {
    console.warn(`  Could not delete branch ${task.branch_name}: ${err.message}`);
  }
}

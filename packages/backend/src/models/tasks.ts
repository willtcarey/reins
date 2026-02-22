/**
 * Task Model
 *
 * Business logic for task creation: orchestrates store calls, git operations,
 * branch-name derivation, and WebSocket broadcasts.
 *
 * Routes and tools call into this layer rather than duplicating the sequence.
 */

import { createTask, type TaskRow } from "../task-store.js";
import { slugifyBranchName } from "../branch-namer.js";
import { branchExists, createBranch, revParse } from "../git.js";
import type { Broadcast } from "./broadcast.js";

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

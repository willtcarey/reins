/**
 * Server side of the `create_task` agent tool (`ReinsToolCalls.createTask`).
 *
 * Creates a task in the calling session's project through the task model layer (branch creation
 * and WS broadcast). With a `prompt`, kicks off an initial session on the new task
 * (fire-and-forget): the task is returned immediately and the session runs in the background.
 */

import type { Models } from "../models/models.js";
import { logger } from "../logger.js";

export interface TaskSessionStarter {
  startTaskSession(taskId: number, prompt: string): Promise<{ sessionId: string }>;
}

export interface CreateTaskScope {
  projectId: number;
  /** The calling session's source: the task's branch is created in its checkout. */
  sourceId: number;
  models: Models;
  /** When set, a prompt starts a session on the new task. */
  instance?: TaskSessionStarter;
}

/** What `create_task` asks for. */
export interface CreateTaskInput { title: string; description: string; branchName?: string; prompt?: string }
/** `task` is the created task row. `sessionStarting` is true when a prompt was given and a session was
 * started (fire-and-forget) on the task. */
export interface CreateTaskResult { task: { id: number; [field: string]: unknown }; sessionStarting: boolean }

/** Loads the project at call time so project path or base branch changes are picked up. */
export async function createTaskForSession(scope: CreateTaskScope, input: CreateTaskInput): Promise<CreateTaskResult> {
  const task = await scope.models.project(scope.projectId, scope.sourceId).tasks().create({
    title: input.title,
    description: input.description,
    branch_name: input.branchName,
  });
  // Fire-and-forget: intentionally not awaited — the tool returns task info immediately.
  const sessionStarting = Boolean(input.prompt && scope.instance);
  if (input.prompt && scope.instance) {
    void scope.instance.startTaskSession(task.id, input.prompt).catch((err: unknown) => {
      logger.error(`  Failed to start session for task ${task.id}:`, err);
    });
  }
  return { task: { ...task }, sessionStarting };
}

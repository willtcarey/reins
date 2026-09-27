/**
 * Server side of the `create_task` agent tool (`project.createTask`).
 *
 * Creates a task in the calling session's project through the task model layer (branch creation
 * and WS broadcast). With a `prompt`, kicks off an initial session on the new task
 * (fire-and-forget): the task is returned immediately and the session runs in the background.
 */

import type { CreateTaskInput, ProjectCreateTaskResult } from "@reins/node/reins-tools";
import type { Broadcast } from "../models/broadcast.js";
import { ProjectModel } from "../models/projects.js";
import { logger } from "../logger.js";

export interface TaskSessionStarter {
  startTaskSession(taskId: number, prompt: string): Promise<{ sessionId: string }>;
}

export interface CreateTaskScope {
  projectId: number;
  broadcast: Broadcast;
  /** When set, a prompt starts a session on the new task. */
  instance?: TaskSessionStarter;
}

/** Loads the project at call time so project path or base branch changes are picked up. */
export async function createTaskForSession(scope: CreateTaskScope, input: CreateTaskInput): Promise<ProjectCreateTaskResult> {
  const task = await new ProjectModel(scope.projectId, scope.broadcast).tasks().create({
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

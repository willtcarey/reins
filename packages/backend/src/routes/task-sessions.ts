/**
 * Task Session Routes (top-level)
 *
 * List and create sessions for a task by its globally-unique ID.
 * Resolves the task's project internally.
 */

import type { RouterGroup } from "../router.js";
import type { RouteContext } from "../router.js";
import { notFound } from "../errors.js";
import { getTask } from "../task-store.js";
import { getProject } from "../project-store.js";
import { touchProject } from "../project-store.js";
import { serializeTaskSessionList, createNewSession, serializeSession } from "../sessions.js";

export function registerTaskSessionRoutes(router: RouterGroup<RouteContext>) {
  // List sessions for a task
  router.get("/:taskId/sessions", async (ctx) => {
    const taskId = parseInt(ctx.params.taskId, 10);
    const task = getTask(taskId);
    if (!task) notFound("Task not found");

    return Response.json(serializeTaskSessionList(taskId));
  });

  // Create a session under a task
  router.post("/:taskId/sessions", async (ctx) => {
    const taskId = parseInt(ctx.params.taskId, 10);
    const task = getTask(taskId);
    if (!task) notFound("Task not found");

    const project = getProject(task!.project_id);
    if (!project) notFound("Project not found");

    touchProject(project!.id);
    const managed = await createNewSession(ctx.state, project!.id, project!.path, { taskId });
    return Response.json(serializeSession(managed), { status: 201 });
  });
}

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
import { parseIntParam } from "./validate.js";

export function registerTaskSessionRoutes(router: RouterGroup<RouteContext>) {
  // List sessions for a task
  router.get("/:taskId/sessions", async (ctx) => {
    const taskId = parseIntParam(ctx.params, "taskId");
    const task = getTask(taskId);
    if (!task) notFound("Task not found");

    const sessions = ctx.models.sessions;
    return Response.json(sessions.listByTask(taskId));
  });

  // Create a session under a task
  router.post("/:taskId/sessions", async (ctx) => {
    const taskId = parseIntParam(ctx.params, "taskId");
    const task = getTask(taskId);
    if (!task) notFound("Task not found");

    const managed = await ctx.models.sessions.create({ projectId: task.project_id, taskId });
    const data = ctx.models.sessions.getDetail(managed.id);
    if (!data) throw new Error(`Failed to load created session: ${managed.id}`);
    return Response.json(data, { status: 201 });
  });
}

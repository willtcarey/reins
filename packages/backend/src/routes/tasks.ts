/**
 * Task Routes (project-scoped)
 *
 * CRUD for tasks and task sessions. Registered under /api/projects/:id.
 */

import type { RouterGroup } from "../router.js";
import type { ProjectRouteContext } from "./index.js";
import { notFound, badRequest, conflict } from "../errors.js";
import { touchProject } from "../project-store.js";
import { getTask } from "../task-store.js";
import { generateTask } from "../task-generator.js";
import {
  TaskNotFoundError,
  TaskHasActiveSessionsError,
} from "../models/tasks.js";
import {
  createNewSession,
  serializeSession,
  serializeTaskSessionList,
} from "../sessions.js";

export function registerTaskRoutes(router: RouterGroup<ProjectRouteContext>) {
  // ---- Tasks ---------------------------------------------------------------

  // List tasks for a project (enriched with diff stats for open tasks)
  router.get("/tasks", async (ctx) => {
    const enriched = await ctx.project.tasks().list();
    return Response.json(enriched);
  });

  // Generate a task from freeform input, then create it
  router.post("/tasks/generate", async (ctx) => {
    const body = (await ctx.req.json()) as { prompt?: string };

    if (!body.prompt?.trim()) {
      badRequest("Prompt is required");
    }

    const generated = await generateTask(body.prompt!.trim());

    try {
      const task = await ctx.project.tasks().create({
        title: generated.title,
        description: generated.description,
        branch_name: generated.branch_name,
      });
      return Response.json(task, { status: 201 });
    } catch (err: any) {
      return Response.json(
        { error: `Failed to create task: ${err.message}` },
        { status: 500 },
      );
    }
  });

  // Get a single task with its sessions
  router.get("/tasks/:taskId", async (ctx) => {
    const taskId = parseInt(ctx.params.taskId, 10);
    const task = getTask(taskId);
    if (!task) notFound("Task not found");

    const sessions = serializeTaskSessionList(task!.id);
    return Response.json({ ...task, sessions });
  });

  // Update a task
  router.patch("/tasks/:taskId", async (ctx) => {
    const taskId = parseInt(ctx.params.taskId, 10);
    const body = (await ctx.req.json()) as { title?: string; description?: string };
    const updated = ctx.project.tasks().update(taskId, body);
    if (!updated) notFound("Task not found");
    return Response.json(updated);
  });

  // Delete a task (with sessions, messages, and git branch)
  router.delete("/tasks/:taskId", async (ctx) => {
    const taskId = parseInt(ctx.params.taskId, 10);

    try {
      await ctx.project.tasks().delete(taskId);
      return Response.json({ ok: true });
    } catch (err: any) {
      if (err instanceof TaskNotFoundError) notFound(err.message);
      if (err instanceof TaskHasActiveSessionsError) conflict(err.message);
      throw err;
    }
  });

  // ---- Task Sessions -------------------------------------------------------

  // List sessions for a task
  router.get("/tasks/:taskId/sessions", async (ctx) => {
    const taskId = parseInt(ctx.params.taskId, 10);
    const task = getTask(taskId);
    if (!task) notFound("Task not found");

    return Response.json(serializeTaskSessionList(taskId));
  });

  // Create a session under a task
  router.post("/tasks/:taskId/sessions", async (ctx) => {
    const taskId = parseInt(ctx.params.taskId, 10);

    const task = getTask(taskId);
    if (!task) notFound("Task not found");
    if (task!.project_id !== ctx.project.projectId) notFound("Task not found");

    touchProject(ctx.project.projectId);
    const managed = await createNewSession(ctx.state, ctx.project.projectId, ctx.project.projectDir, { taskId });
    return Response.json(serializeSession(managed), { status: 201 });
  });
}

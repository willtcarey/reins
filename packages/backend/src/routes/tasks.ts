/**
 * Task Routes (project-scoped)
 *
 * CRUD for tasks. Registered under /api/projects/:id.
 */

import { Type } from "@sinclair/typebox";
import type { RouterGroup } from "../router.js";
import type { ProjectRouteContext } from "./index.js";
import { notFound, conflict } from "../errors.js";
import { getTask } from "../task-store.js";
import { generateTask } from "../task-generator.js";
import {
  TaskNotFoundError,
  TaskHasActiveSessionsError,
} from "../models/tasks.js";
import { serializeTaskSessionList } from "../sessions.js";
import { parseBody, parseIntParam } from "./validate.js";

const GenerateTaskBody = Type.Object({
  prompt: Type.String({ minLength: 1, pattern: "\\S" }),
});

const UpdateTaskBody = Type.Object({
  title: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
});

export function registerTaskRoutes(router: RouterGroup<ProjectRouteContext>) {
  // ---- Tasks ---------------------------------------------------------------

  // List tasks for a project (enriched with diff stats for open tasks)
  router.get("/tasks", async (ctx) => {
    const enriched = await ctx.project.tasks().listWithDiffStats();
    return Response.json(enriched);
  });

  // Generate a task from freeform input, then create it
  router.post("/tasks/generate", async (ctx) => {
    const body = await parseBody(GenerateTaskBody, ctx.req);

    const generated = await generateTask(body.prompt.trim());

    try {
      const task = await ctx.project.tasks().create({
        title: generated.title,
        description: generated.description,
        branch_name: generated.branch_name,
      });
      return Response.json(task, { status: 201 });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return Response.json(
        { error: `Failed to create task: ${message}` },
        { status: 500 },
      );
    }
  });

  // Get a single task with its sessions
  router.get("/tasks/:taskId", async (ctx) => {
    const taskId = parseIntParam(ctx.params, "taskId");
    const task = getTask(taskId);
    if (!task) notFound("Task not found");

    const sessions = serializeTaskSessionList(task.id);
    return Response.json({ ...task, sessions });
  });

  // Update a task
  router.patch("/tasks/:taskId", async (ctx) => {
    const taskId = parseIntParam(ctx.params, "taskId");
    const body = await parseBody(UpdateTaskBody, ctx.req);
    const updated = ctx.project.tasks().update(taskId, body);
    if (!updated) notFound("Task not found");
    return Response.json(updated);
  });

  // Delete a task (with sessions, messages, and git branch)
  router.delete("/tasks/:taskId", async (ctx) => {
    const taskId = parseIntParam(ctx.params, "taskId");

    try {
      await ctx.project.tasks().delete(taskId);
      return Response.json({ ok: true });
    } catch (err: unknown) {
      if (err instanceof TaskNotFoundError) notFound(err.message);
      if (err instanceof TaskHasActiveSessionsError) conflict(err.message);
      throw err;
    }
  });

}

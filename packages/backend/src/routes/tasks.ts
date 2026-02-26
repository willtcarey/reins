/**
 * Task Routes (project-scoped)
 *
 * CRUD for tasks and task sessions. Registered under /api/projects/:id.
 */

import type { RouterGroup, RouteContext } from "../router.js";
import { notFound, badRequest, conflict } from "../errors.js";
import { getProject, touchProject } from "../project-store.js";
import { getTask } from "../task-store.js";
import { generateTask } from "../task-generator.js";
import {
  createTaskWithBranch,
  listTasksWithDiffStats,
  updateTaskAndBroadcast,
  deleteTaskWithBranch,
  TaskNotFoundError,
  TaskHasActiveSessionsError,
} from "../models/tasks.js";
import { createBroadcast } from "../models/broadcast.js";
import {
  createNewSession,
  serializeSession,
  serializeTaskSessionList,
} from "../sessions.js";

export function registerTaskRoutes(router: RouterGroup) {
  // ---- Tasks ---------------------------------------------------------------

  // List tasks for a project (enriched with diff stats for open tasks)
  router.get("/tasks", async (ctx: RouteContext) => {
    const projectId = parseInt(ctx.params.id, 10);
    const projectDir = (ctx as any).projectDir as string;
    const project = getProject(projectId)!;

    const enriched = await listTasksWithDiffStats(projectId, projectDir, project.base_branch);
    return Response.json(enriched);
  });

  // Generate a task from freeform input, then create it
  router.post("/tasks/generate", async (ctx: RouteContext) => {
    const projectId = parseInt(ctx.params.id, 10);
    const projectDir = (ctx as any).projectDir as string;
    const project = getProject(projectId)!;
    const body = (await ctx.req.json()) as { prompt?: string };

    if (!body.prompt?.trim()) {
      badRequest("Prompt is required");
    }

    const generated = await generateTask(body.prompt!.trim());

    try {
      const task = await createTaskWithBranch(
        projectId,
        projectDir,
        project.base_branch,
        {
          title: generated.title,
          description: generated.description,
          branch_name: generated.branch_name,
        },
        createBroadcast(ctx.state.clients),
      );
      return Response.json(task, { status: 201 });
    } catch (err: any) {
      return Response.json(
        { error: `Failed to create task: ${err.message}` },
        { status: 500 },
      );
    }
  });

  // Get a single task with its sessions
  router.get("/tasks/:taskId", async (ctx: RouteContext) => {
    const taskId = parseInt(ctx.params.taskId, 10);
    const task = getTask(taskId);
    if (!task) notFound("Task not found");

    const sessions = serializeTaskSessionList(task!.id);
    return Response.json({ ...task, sessions });
  });

  // Update a task
  router.patch("/tasks/:taskId", async (ctx: RouteContext) => {
    const projectId = parseInt(ctx.params.id, 10);
    const taskId = parseInt(ctx.params.taskId, 10);
    const body = (await ctx.req.json()) as { title?: string; description?: string };
    const updated = updateTaskAndBroadcast(taskId, projectId, body, createBroadcast(ctx.state.clients));
    if (!updated) notFound("Task not found");
    return Response.json(updated);
  });

  // Delete a task (with sessions, messages, and git branch)
  router.delete("/tasks/:taskId", async (ctx: RouteContext) => {
    const projectId = parseInt(ctx.params.id, 10);
    const taskId = parseInt(ctx.params.taskId, 10);
    const projectDir = (ctx as any).projectDir as string;
    const project = getProject(projectId)!;

    try {
      await deleteTaskWithBranch(
        taskId,
        projectId,
        projectDir,
        project.base_branch,
        ctx.state.sessions,
        createBroadcast(ctx.state.clients),
      );
      return Response.json({ ok: true });
    } catch (err: any) {
      if (err instanceof TaskNotFoundError) notFound(err.message);
      if (err instanceof TaskHasActiveSessionsError) conflict(err.message);
      throw err;
    }
  });

  // ---- Task Sessions -------------------------------------------------------

  // List sessions for a task
  router.get("/tasks/:taskId/sessions", async (ctx: RouteContext) => {
    const taskId = parseInt(ctx.params.taskId, 10);
    const task = getTask(taskId);
    if (!task) notFound("Task not found");

    return Response.json(serializeTaskSessionList(taskId));
  });

  // Create a session under a task
  router.post("/tasks/:taskId/sessions", async (ctx: RouteContext) => {
    const projectId = parseInt(ctx.params.id, 10);
    const taskId = parseInt(ctx.params.taskId, 10);
    const projectDir = (ctx as any).projectDir as string;

    const task = getTask(taskId);
    if (!task) notFound("Task not found");
    if (task!.project_id !== projectId) notFound("Task not found");

    touchProject(projectId);
    const managed = await createNewSession(ctx.state, projectId, projectDir, { taskId });
    return Response.json(serializeSession(managed), { status: 201 });
  });
}

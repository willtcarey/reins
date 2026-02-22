/**
 * Task Routes (project-scoped)
 *
 * CRUD for tasks and task sessions. Registered under /api/projects/:id.
 */

import type { RouterGroup, RouteContext } from "../router.js";
import { notFound, badRequest } from "../errors.js";
import { getProject } from "../project-store.js";
import {
  getTask,
  listTasks,
  updateTask,
  deleteTask,
  getTaskSessionIds,
} from "../task-store.js";
import { generateTask } from "../task-generator.js";
import { deleteBranch, getCurrentBranch, checkoutBranch, getDiffStats } from "../git.js";
import { createTaskWithBranch } from "../models/tasks.js";
import { createBroadcast } from "../models/broadcast.js";
import {
  createNewSession,
  serializeSession,
  serializeTaskSessionList,
} from "../sessions.js";
import { touchProject } from "../project-store.js";

export function registerTaskRoutes(router: RouterGroup) {
  // ---- Tasks ---------------------------------------------------------------

  // List tasks for a project (enriched with diff stats for open tasks)
  router.get("/tasks", async (ctx: RouteContext) => {
    const projectId = parseInt(ctx.params.id, 10);
    const projectDir = (ctx as any).projectDir as string;
    const project = getProject(projectId)!;
    const tasks = listTasks(projectId);

    const enriched = await Promise.all(
      tasks.map(async (task) => {
        if (task.status !== "open") {
          return { ...task, diffStats: null };
        }
        try {
          const diffStats = await getDiffStats(projectDir, task.branch_name, project.base_branch);
          return { ...task, diffStats };
        } catch {
          return { ...task, diffStats: null };
        }
      }),
    );

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
    const updated = updateTask(taskId, body);
    if (!updated) notFound("Task not found");
    createBroadcast(ctx.state.clients)({ type: "task_updated", projectId });
    return Response.json(updated);
  });

  // Delete a task (with sessions, messages, and git branch)
  router.delete("/tasks/:taskId", async (ctx: RouteContext) => {
    const projectId = parseInt(ctx.params.id, 10);
    const taskId = parseInt(ctx.params.taskId, 10);
    const projectDir = (ctx as any).projectDir as string;

    const task = getTask(taskId);
    if (!task) notFound("Task not found");
    if (task!.project_id !== projectId) notFound("Task not found");

    // Check for active (in-memory, streaming) sessions
    const sessionIds = getTaskSessionIds(taskId);
    const activeSessions: string[] = [];
    for (const sid of sessionIds) {
      const managed = ctx.state.sessions.get(sid);
      if (managed && managed.session.isStreaming) {
        activeSessions.push(sid);
      }
    }
    if (activeSessions.length > 0) {
      return Response.json(
        { error: `Cannot delete task: ${activeSessions.length} session(s) are currently running` },
        { status: 409 },
      );
    }

    // Remove in-memory sessions for this task
    for (const sid of sessionIds) {
      ctx.state.sessions.delete(sid);
    }

    // Delete task (cascades sessions + messages in DB)
    deleteTask(taskId);
    createBroadcast(ctx.state.clients)({ type: "task_updated", projectId });

    // Delete the git branch (best-effort — may fail if checked out)
    try {
      const currentBranch = await getCurrentBranch(projectDir);
      if (currentBranch === task!.branch_name) {
        // Switch away first
        const project = getProject(projectId)!;
        await checkoutBranch(projectDir, project.base_branch);
      }
      await deleteBranch(projectDir, task!.branch_name);
    } catch (err: any) {
      // Branch may already be gone — log but don't fail
      console.warn(`  Could not delete branch ${task!.branch_name}: ${err.message}`);
    }

    return Response.json({ ok: true });
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

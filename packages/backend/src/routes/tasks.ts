/**
 * Task Routes (project-scoped)
 *
 * CRUD for tasks and task sessions. Registered under /api/projects/:id.
 */

import type { RouterGroup, RouteContext } from "../router.js";
import { notFound, badRequest } from "../errors.js";
import { getProject } from "../project-store.js";
import {
  createTask,
  getTask,
  listTasks,
  updateTask,
  deleteTask,
  getTaskSessionIds,
} from "../task-store.js";
import { generateBranchName } from "../branch-namer.js";
import { generateTask } from "../task-generator.js";
import { createBranch, branchExists, deleteBranch, getCurrentBranch, checkoutBranch } from "../git.js";
import {
  createNewSession,
  serializeSession,
  serializeTaskSessionList,
} from "../sessions.js";
import { touchProject } from "../project-store.js";

export function registerTaskRoutes(router: RouterGroup) {
  // ---- Tasks ---------------------------------------------------------------

  // List tasks for a project
  router.get("/tasks", async (ctx: RouteContext) => {
    const projectId = parseInt(ctx.params.id, 10);
    return Response.json(listTasks(projectId));
  });

  // Create a new task
  router.post("/tasks", async (ctx: RouteContext) => {
    const projectId = parseInt(ctx.params.id, 10);
    const projectDir = (ctx as any).projectDir as string;
    const project = getProject(projectId)!;
    const body = (await ctx.req.json()) as { title?: string; description?: string; branch_name?: string };

    if (!body.title?.trim()) {
      badRequest("Title is required");
    }

    const title = body.title!.trim();
    const description = body.description?.trim() || null;

    // Use provided branch name or generate one
    const branchName = body.branch_name?.trim() || await generateBranchName(title);

    // Check for collision
    if (await branchExists(projectDir, branchName)) {
      return Response.json(
        { error: `Branch "${branchName}" already exists` },
        { status: 409 },
      );
    }

    // Create the git branch from the project's base branch
    try {
      await createBranch(projectDir, branchName, project.base_branch);
    } catch (err: any) {
      return Response.json(
        { error: `Failed to create branch: ${err.message}` },
        { status: 500 },
      );
    }

    // Create the task row
    const task = createTask(projectId, title, description, branchName);
    return Response.json(task, { status: 201 });
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

    // Ensure branch doesn't collide
    let branchName = generated.branch_name;
    if (await branchExists(projectDir, branchName)) {
      // Append a short suffix
      const suffix = Date.now().toString(36).slice(-4);
      branchName = `${branchName}-${suffix}`;
    }

    try {
      await createBranch(projectDir, branchName, project.base_branch);
    } catch (err: any) {
      return Response.json(
        { error: `Failed to create branch: ${err.message}` },
        { status: 500 },
      );
    }

    const task = createTask(projectId, generated.title, generated.description, branchName);
    return Response.json(task, { status: 201 });
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
    const taskId = parseInt(ctx.params.taskId, 10);
    const body = (await ctx.req.json()) as { title?: string; description?: string };
    const updated = updateTask(taskId, body);
    if (!updated) notFound("Task not found");
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

/**
 * Task Routes (project-scoped)
 *
 * CRUD for tasks. Registered under /api/projects/:id.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { RouterGroup } from "../router.js";
import type { ProjectRouteContext } from "./index.js";
import { notFound, conflict, HttpError, isNodeUnavailable } from "../errors.js";
import { getTask, type TaskRow } from "../task-store.js";
import type { SessionListView } from "../models/sessions.js";
import type { TaskWithDiffStats } from "../models/tasks.js";
import { generateTask } from "../task-generator.js";
import {
  TaskNotFoundError,
  TaskHasActiveSessionsError,
} from "../models/tasks.js";
import { Sessions } from "../models/sessions.js";
import { closeDeletedSessions, sessionsOnNodes } from "../sessions/session-ownership.js";
import { parseBody, parseCollectionPage, parseIntParam } from "./validate.js";

export type TaskDetail = TaskRow & { sessions: SessionListView[] };
export interface TaskHistoryPage { items: TaskWithDiffStats[]; hasMore: boolean }

const GenerateTaskBody = Type.Object({
  prompt: Type.String({ minLength: 1, pattern: "\\S" }),
});

const UpdateTaskBody = Type.Object({
  title: Type.Optional(Type.String()),
  description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  base_commit: Type.Optional(Type.String()),
});

export type GeneratedTaskInput = Static<typeof GenerateTaskBody>;
export type TaskUpdate = Static<typeof UpdateTaskBody>;

export function registerTaskRoutes(router: RouterGroup<ProjectRouteContext>) {
  // ---- Tasks ---------------------------------------------------------------

  // List tasks for a project (enriched with diff stats for open tasks)
  router.get("/tasks", async (ctx) => {
    const status = ctx.url.searchParams.get("status");
    if (status !== null && status !== "open" && status !== "closed") {
      throw new HttpError(400, "Query parameter 'status' must be 'open' or 'closed'");
    }
    const page = parseCollectionPage(ctx.url);
    const enriched = await ctx.project.tasks().listWithDiffStats(status ?? undefined, page ? {
      limit: page.limit + 1,
      offset: page.offset,
      search: page.search,
    } : {});
    if (!page) return Response.json(enriched);
    return Response.json({
      items: enriched.slice(0, page.limit),
      hasMore: enriched.length > page.limit,
    } satisfies TaskHistoryPage);
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
      if (isNodeUnavailable(err)) throw err;
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

    const archived = ctx.url.searchParams.get("archived") === "include" ? "include" : "exclude";
    const sessions = new Sessions(ctx.state.nodes).listByTask(task.id, archived);
    return Response.json({ ...task, sessions } satisfies TaskDetail);
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
      const sessions = sessionsOnNodes({ taskId });
      await ctx.project.tasks().delete(taskId);
      closeDeletedSessions(ctx.state.nodes, sessions);
      return Response.json({ ok: true });
    } catch (err: unknown) {
      if (err instanceof TaskNotFoundError) notFound(err.message);
      if (err instanceof TaskHasActiveSessionsError) conflict(err.message);
      throw err;
    }
  });

}

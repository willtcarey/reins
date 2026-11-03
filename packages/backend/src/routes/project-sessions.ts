/**
 * Project Session Routes (project-scoped)
 *
 * These routes are registered under /api/projects/:id and receive
 * the project context via the project middleware.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { RouterGroup } from "../router.js";
import type { SessionListView } from "../models/sessions.js";
import type { ProjectRouteContext } from "./index.js";
import { badRequest } from "../errors.js";
import { parseCollectionPage, parseOptionalBody } from "./validate.js";
import { SessionLocationSchema, SessionModelChoiceSchema } from "../sessions/create-session.js";

export type ArchivedSessionHistoryItem = SessionListView & { taskTitle: string | null };
export interface ArchivedSessionPage { items: ArchivedSessionHistoryItem[]; hasMore: boolean }

/** A new session's options, all optional: without them, a conversation of the project's assistant in its
 * default source with the `default_model` setting's model. */
const SessionCreateBody = Type.Object({
  /** A task of the project; null or left out: a conversation of the project's assistant. */
  taskId: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  /** Where it works, a node and a path (a directory not known yet is checked on its node); left out, as
   * `createSession` inherits: the task's latest session's, else the project's default source. */
  source: Type.Optional(SessionLocationSchema),
  /** Its name, trimmed; left out, the session is named as any is. */
  title: Type.Optional(Type.String()),
  model: Type.Optional(SessionModelChoiceSchema),
});
export type SessionCreateRequest = Static<typeof SessionCreateBody>;

export function registerProjectSessionRoutes(router: RouterGroup<ProjectRouteContext>) {
  // List sessions for a project
  router.get("/sessions", async (ctx) => {
    const sessions = ctx.models.sessions;
    if (ctx.url.searchParams.get("archived") === "only") {
      const page = parseCollectionPage(ctx.url);
      const taskTitles = new Map(
        ctx.project.tasks().list().map((task) => [task.id, task.title]),
      );
      const archived = sessions.listArchivedByProject(ctx.project.projectId, page ? {
        limit: page.limit + 1,
        offset: page.offset,
        search: page.search,
      } : {});
      const items = archived.slice(0, page?.limit).map((session) => ({
        ...session,
        taskTitle: session.taskId == null ? null : taskTitles.get(session.taskId) ?? null,
      }));
      if (!page) return Response.json(items);
      return Response.json({
        items,
        hasMore: archived.length > page.limit,
      } satisfies ArchivedSessionPage);
    }
    return Response.json(sessions.listByProject(ctx.project.projectId));
  });

  // Where a new session (of `?taskId=`, a task of the project) can work, and works by default.
  router.get("/locations", async (ctx) => {
    const taskParam = ctx.url.searchParams.get("taskId");
    const taskId = taskParam === null ? undefined : Number(taskParam);
    if (taskId !== undefined && !Number.isInteger(taskId)) badRequest(`taskId must be an integer: ${taskParam}`);
    return Response.json(ctx.models.sessions.locations(ctx.project.projectId, taskId));
  });

  // Create a new session
  router.post("/sessions", async (ctx) => {
    const { taskId, source, title, model } = await parseOptionalBody(SessionCreateBody, ctx.req);
    const projectId = ctx.project.projectId;
    const managed = await ctx.models.sessions.create({
      projectId,
      ...(taskId == null ? {} : { taskId }),
      ...(source ? { source } : {}),
      ...(title === undefined ? {} : { title }),
      ...(model ? { model } : {}),
    });
    const data = ctx.models.sessions.getDetail(managed.id);
    if (!data) throw new Error(`Failed to load created session: ${managed.id}`);
    return Response.json(data, { status: 201 });
  });
}

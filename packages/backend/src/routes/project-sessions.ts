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
import { createSession } from "../sessions/create-session.js";
import { touchProject } from "../project-store.js";
import { getTask } from "../task-store.js";
import { listSources } from "../node-store.js";
import { badRequest } from "../errors.js";
import { ThinkingLevelSchema } from "../models/model-settings.js";
import { findPiModel } from "../pi/model-catalog.js";
import { createDbCredentialStore } from "../pi/credential-store.js";
import { parseCollectionPage, parseOptionalBody } from "./validate.js";

export type ArchivedSessionHistoryItem = SessionListView & { taskTitle: string | null };
export interface ArchivedSessionPage { items: ArchivedSessionHistoryItem[]; hasMore: boolean }

/** A new session's options, all optional: without them, a conversation of the project's assistant on its
 * default source with the `default_model` setting's model. */
const SessionCreateBody = Type.Object({
  /** A task of the project; null or left out: a conversation of the project's assistant. */
  taskId: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  /** A source of the project, by its node and path. */
  source: Type.Optional(Type.Object({ nodeId: Type.String({ minLength: 1 }), path: Type.String({ minLength: 1 }) })),
  /** Its name, trimmed; left out, the session is named as any is. */
  title: Type.Optional(Type.String()),
  model: Type.Optional(Type.Object({
    provider: Type.String({ minLength: 1 }),
    modelId: Type.String({ minLength: 1 }),
    thinkingLevel: Type.Optional(ThinkingLevelSchema),
  })),
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

  // Create a new session
  router.post("/sessions", async (ctx) => {
    const { taskId, source: place, title, model } = await parseOptionalBody(SessionCreateBody, ctx.req);
    const projectId = ctx.project.projectId;
    if (taskId != null && getTask(taskId)?.project_id !== projectId) badRequest(`Task ${taskId} is not a task of this project`);
    const source = place && listSources(projectId).find((candidate) => candidate.node_id === place.nodeId && candidate.path === place.path);
    if (place && !source) badRequest(`This project has no source at ${place.path} on node ${place.nodeId}`);
    if (title !== undefined && !title.trim()) badRequest("The title must not be blank");
    if (model && !await findPiModel(createDbCredentialStore(ctx.state.process), model.provider, model.modelId)) {
      badRequest(`Model '${model.modelId}' not found for provider '${model.provider}'`);
    }

    touchProject(projectId);
    const managed = createSession(ctx.state, projectId, {
      taskId: taskId ?? undefined,
      sourceId: source?.id,
      title: title?.trim(),
      model: model && { provider: model.provider, modelId: model.modelId },
      thinkingLevel: model?.thinkingLevel,
    });
    const sessions = ctx.models.sessions;
    const data = sessions.getDetail(managed.id);
    if (!data) throw new Error(`Failed to load created session: ${managed.id}`);
    return Response.json(data, { status: 201 });
  });
}

/**
 * Project Session Routes (project-scoped)
 *
 * These routes are registered under /api/projects/:id and receive
 * the project context via the project middleware.
 */

import type { RouterGroup } from "../router.js";
import type { SessionListView } from "../models/sessions.js";
import type { ProjectRouteContext } from "./index.js";
import { createNewSession } from "../runtimes/session-manager.js";
import { Sessions } from "../models/sessions.js";
import { touchProject } from "../project-store.js";
import { parseCollectionPage } from "./validate.js";

export type ArchivedSessionHistoryItem = SessionListView & { taskTitle: string | null };
export interface ArchivedSessionPage { items: ArchivedSessionHistoryItem[]; hasMore: boolean }

export function registerProjectSessionRoutes(router: RouterGroup<ProjectRouteContext>) {
  // List sessions for a project
  router.get("/sessions", async (ctx) => {
    const sessions = new Sessions(ctx.state.nodes);
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
    touchProject(ctx.project.projectId);
    const managed = await createNewSession(ctx.state, ctx.project.projectId);
    const sessions = new Sessions(ctx.state.nodes);
    const data = sessions.get(managed.id);
    if (!data) throw new Error(`Failed to load created session: ${managed.id}`);
    return Response.json(data, { status: 201 });
  });
}

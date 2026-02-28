/**
 * Project Session Routes (project-scoped)
 *
 * These routes are registered under /api/projects/:id and receive
 * the project context via the project middleware.
 */

import type { RouterGroup } from "../router.js";
import type { ProjectRouteContext } from "./index.js";
import {
  createNewSession, serializeSession,
  serializeSessionList,
} from "../sessions.js";
import { touchProject } from "../project-store.js";

export function registerProjectSessionRoutes(router: RouterGroup<ProjectRouteContext>) {
  // List sessions for a project
  router.get("/sessions", async (ctx) => {
    return Response.json(serializeSessionList(ctx.project.projectId));
  });

  // Create a new session
  router.post("/sessions", async (ctx) => {
    touchProject(ctx.project.projectId);
    const managed = await createNewSession(ctx.state, ctx.project.projectId, ctx.project.projectDir);
    return Response.json(serializeSession(managed), { status: 201 });
  });
}

/**
 * Session Routes (project-scoped)
 *
 * These routes are registered under /api/projects/:id and receive
 * the project context via the project middleware.
 */

import type { RouterGroup, RouteContext } from "../router.js";
import {
  createNewSession, serializeSession,
  serializeSessionFromDb, serializeSessionList,
  ensureSessionOpen,
} from "../sessions.js";
import { touchProject } from "../project-store.js";

export function registerSessionRoutes(router: RouterGroup) {
  // List sessions for a project
  router.get("/sessions", async (ctx: RouteContext) => {
    const projectId = parseInt(ctx.params.id, 10);
    return Response.json(serializeSessionList(projectId));
  });

  // Create a new session
  router.post("/sessions", async (ctx: RouteContext) => {
    const projectId = parseInt(ctx.params.id, 10);
    const projectDir = (ctx as any).projectDir as string;
    touchProject(projectId);
    const managed = await createNewSession(ctx.state, projectId, projectDir);
    return Response.json(serializeSession(managed), { status: 201 });
  });

  // Get a specific session by ID
  router.get("/sessions/:sessionId", async (ctx: RouteContext) => {
    const sessionId = ctx.params.sessionId;
    const projectDir = (ctx as any).projectDir as string;

    // If already open in memory, use that (includes isStreaming state)
    const existing = ctx.state.sessions.get(sessionId);
    if (existing) {
      return Response.json(serializeSession(existing));
    }

    // Otherwise read from SQLite
    const data = serializeSessionFromDb(sessionId);
    if (!data) {
      return new Response("Session not found", { status: 404 });
    }
    return Response.json(data);
  });
}

/**
 * Session Routes (project-scoped)
 *
 * These routes are registered under /api/projects/:id and receive
 * the project context via the project middleware.
 */

import { SessionManager } from "@mariozechner/pi-coding-agent";
import type { RouterGroup, RouteContext } from "../router.js";
import {
  openSession, findOpenSession, serializeSession,
  readSessionFromDisk, serializeSessionList,
} from "../sessions.js";
import { touchProject } from "../project-store.js";

export function registerSessionRoutes(router: RouterGroup) {
  // List sessions for a project
  router.get("/sessions", async (ctx: RouteContext) => {
    const projectDir = (ctx as any).projectDir as string;
    return Response.json(await serializeSessionList(projectDir));
  });

  // Create a new session
  router.post("/sessions", async (ctx: RouteContext) => {
    const projectId = parseInt(ctx.params.id, 10);
    const projectDir = (ctx as any).projectDir as string;
    touchProject(projectId);
    const sessionManager = SessionManager.create(projectDir);
    const managed = await openSession(ctx.state, projectDir, sessionManager);
    return Response.json(serializeSession(managed), { status: 201 });
  });

  // Get a specific session
  router.get("/sessions/:path+", async (ctx: RouteContext) => {
    const sessionPath = ctx.params.path;
    // If already open in memory, use that (includes isStreaming state)
    const open = findOpenSession(ctx.state, sessionPath);
    if (open) {
      return Response.json(serializeSession(open));
    }
    // Otherwise read from disk — no AgentSession created
    return Response.json(readSessionFromDisk(sessionPath));
  });
}

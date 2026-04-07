/**
 * Session Routes (top-level)
 *
 * Resource routes for sessions by globally-unique ID.
 * Returns session data with `project_id` so the frontend can
 * derive the active project context from a session URL.
 */

import { Type } from "@sinclair/typebox";
import type { RouterGroup } from "../router.js";
import type { RouteContext } from "../router.js";
import { badRequest, notFound } from "../errors.js";
import { ProjectSessions } from "../models/sessions.js";
import { getSession as dbGetSession } from "../session-store.js";
import { serializeSession, serializeSessionFromDb } from "../pi/sessions.js";
import { parseBody } from "./validate.js";

const SessionModelBody = Type.Object({
  provider: Type.String(),
  modelId: Type.String(),
  thinkingLevel: Type.Optional(Type.String()),
});

export function registerSessionRoutes(router: RouterGroup<RouteContext>) {
  router.put("/:sessionId/model", async (ctx) => {
    const sessionId = ctx.params.sessionId;
    const row = dbGetSession(sessionId);
    if (!row) {
      notFound(`Session not found: ${sessionId}`);
    }

    const body = await parseBody(SessionModelBody, ctx.req);

    try {
      const sessions = new ProjectSessions(row.project_id, ctx.state.sessions, () => {});
      const updated = await sessions.setModel({ sessionId, ...body });
      return Response.json(updated);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to update session model";
      if (message.includes("not found")) {
        notFound(message);
      }
      badRequest(message);
    }
  });

  // Get a session by its globally-unique ID
  router.get("/:sessionId", async (ctx) => {
    const sessionId = ctx.params.sessionId;

    // Check in-memory sessions first (includes isStreaming state)
    const existing = ctx.state.sessions.get(sessionId);
    if (existing) {
      const data = serializeSession(existing);
      const row = dbGetSession(sessionId);
      return Response.json({ ...data, project_id: row?.project_id ?? null });
    }

    // Otherwise read from SQLite
    const row = dbGetSession(sessionId);
    if (!row) {
      return new Response("Session not found", { status: 404 });
    }

    const data = serializeSessionFromDb(sessionId);
    if (!data) {
      return new Response("Session not found", { status: 404 });
    }

    return Response.json({ ...data, project_id: row.project_id });
  });
}

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
import { SessionNotFoundError, Sessions } from "../models/sessions.js";
import { createBroadcast } from "../models/broadcast.js";
import { parseBody } from "./validate.js";

const SessionModelBody = Type.Object({
  runtimeType: Type.Optional(Type.String()),
  provider: Type.String(),
  modelId: Type.String(),
  thinkingLevel: Type.Optional(Type.String()),
});

export function registerSessionRoutes(router: RouterGroup<RouteContext>) {
  // List all sessions with non-null activity_state — for initial page-load
  // reconciliation without needing to expand every project first.
  router.get("/activity", (ctx) => {
    return Response.json(new Sessions(ctx.state.sessions).activeSessions());
  });

  router.put("/:sessionId/model", async (ctx) => {
    const sessionId = ctx.params.sessionId;
    const body = await parseBody(SessionModelBody, ctx.req);

    try {
      const sessions = new Sessions(ctx.state.sessions);
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

  router.get("/:sessionId/messages", async (ctx) => {
    const sessionId = ctx.params.sessionId;
    const sessions = new Sessions(ctx.state.sessions);
    const messages = sessions.getMessages(sessionId);
    if (!messages) {
      return new Response("Session not found", { status: 404 });
    }

    return Response.json(messages);
  });

  // Get a session by its globally-unique ID
  router.get("/:sessionId", async (ctx) => {
    const sessionId = ctx.params.sessionId;

    const data = new Sessions(ctx.state.sessions).get(sessionId);
    if (!data) {
      return new Response("Session not found", { status: 404 });
    }

    return Response.json(data);
  });

  // Mark a session's activity as viewed (finished → null)
  router.patch("/:sessionId/activity", async (ctx) => {
    const sessionId = ctx.params.sessionId;
    const broadcast = createBroadcast(ctx.state.clients);
    const sessions = new Sessions(ctx.state.sessions, broadcast);
    try {
      sessions.markActivityViewed(sessionId);
    } catch (err) {
      if (err instanceof SessionNotFoundError) {
        return new Response("Session not found", { status: 404 });
      }
      throw err;
    }
    return Response.json({ ok: true });
  });
}

/**
 * Session Routes (top-level)
 *
 * Resource routes for sessions by globally-unique ID.
 * Returns session data with `project_id` so the frontend can
 * derive the active project context from a session URL.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { RouterGroup } from "../router.js";
import type { RouteContext } from "../router.js";
import { badRequest, HttpError } from "../errors.js";
import { SessionNotFoundError, Sessions } from "../models/sessions.js";
import { createBroadcast } from "../models/broadcast.js";
import { parseDisplayCursor } from "../messages-store.js";
import { parseBody } from "./validate.js";
import { executeSessionCommand } from "../runtimes/node-execution.js";
import { withSessionNotFound } from "./session-errors.js";

export interface MessagePageQuery { before?: string; after?: string; limit?: number }
export interface ActivitySnapshotItem {
  id: string;
  projectId: number;
  taskId: number | null;
  activityState: "running" | "finished";
}

const DEFAULT_MESSAGE_PAGE_LIMIT = 50;
const MAX_MESSAGE_PAGE_LIMIT = 200;

const SessionModelBody = Type.Object({
  runtimeType: Type.Optional(Type.String()),
  provider: Type.String(),
  modelId: Type.String(),
  thinkingLevel: Type.Optional(Type.String()),
});

const SessionActivityBody = Type.Object({
  unread: Type.Boolean(),
});

const SessionMetadataBody = Type.Object({
  name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  pinned: Type.Optional(Type.Boolean()),
  archived: Type.Optional(Type.Boolean()),
}, { minProperties: 1 });

export type SessionModelUpdate = Static<typeof SessionModelBody>;
export type SessionActivityUpdate = Static<typeof SessionActivityBody>;
export type SessionMetadataUpdate = Static<typeof SessionMetadataBody>;

export function registerSessionRoutes(router: RouterGroup<RouteContext>) {
  // List all sessions with non-null activity_state — for initial page-load
  // reconciliation without needing to expand every project first.
  router.get("/activity", (ctx) => {
    return Response.json(new Sessions(ctx.state.sessions).activeSessions());
  });

  router.put("/:sessionId/model", withSessionNotFound(async (ctx) => {
    const sessionId = ctx.params.sessionId;
    const body = await parseBody(SessionModelBody, ctx.req);

    try {
      const sessions = new Sessions(ctx.state.sessions);
      const updated = await sessions.setModel({ sessionId, ...body });
      return Response.json(updated);
    } catch (err: unknown) {
      if (err instanceof SessionNotFoundError) throw err;
      const message = err instanceof Error ? err.message : "Failed to update session model";
      badRequest(message);
    }
  }));

  router.get("/:sessionId/context", withSessionNotFound(async (ctx) => {
    const snapshot = await new Sessions(ctx.state.sessions).getContext(ctx.params.sessionId);
    return Response.json(snapshot);
  }));

  router.get("/:sessionId/messages", withSessionNotFound(async (ctx) => {
    const sessionId = ctx.params.sessionId;
    const limitParam = ctx.url.searchParams.get("limit");
    const limit = limitParam === null ? DEFAULT_MESSAGE_PAGE_LIMIT : Number(limitParam);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_MESSAGE_PAGE_LIMIT) {
      badRequest(`limit must be an integer between 1 and ${MAX_MESSAGE_PAGE_LIMIT}`);
    }

    const beforeCursor = ctx.url.searchParams.get("before");
    const afterCursor = ctx.url.searchParams.get("after");
    if (beforeCursor !== null && afterCursor !== null) badRequest("before and after are mutually exclusive");
    const beforeSeq = beforeCursor === null ? undefined : parseDisplayCursor(sessionId, beforeCursor, "before");
    const afterSeq = afterCursor === null ? undefined : parseDisplayCursor(sessionId, afterCursor, "after");
    if (beforeCursor !== null && beforeSeq === null) badRequest("Invalid before cursor");
    if (afterCursor !== null && afterSeq === null) badRequest("Invalid after cursor");

    const sessions = new Sessions(ctx.state.sessions);
    const page = sessions.getMessagePage(sessionId, limit, {
      beforeSeq: beforeSeq ?? undefined,
      afterSeq: afterSeq ?? undefined,
    });
    if (!page) throw new SessionNotFoundError();

    return Response.json(page);
  }));

  // Get a session by its globally-unique ID
  router.get("/:sessionId", withSessionNotFound(async (ctx) => {
    const sessionId = ctx.params.sessionId;

    const data = new Sessions(ctx.state.sessions).get(sessionId);
    if (!data) throw new SessionNotFoundError();

    return Response.json(data);
  }));

  router.post("/:sessionId/resume", withSessionNotFound(async (ctx) => {
    const sessionId = ctx.params.sessionId;
    if (!new Sessions(ctx.state.sessions).get(sessionId)) throw new SessionNotFoundError();
    try {
      await executeSessionCommand(ctx.state, sessionId, "resumePending");
      return Response.json({ ok: true });
    } catch (err: unknown) {
      if (err instanceof HttpError) throw err;
      badRequest(err instanceof Error ? err.message : "Failed to resume pending operation");
    }
  }));

  router.patch("/:sessionId/metadata", withSessionNotFound(async (ctx) => {
    const sessionId = ctx.params.sessionId;
    const body = await parseBody(SessionMetadataBody, ctx.req);
    const sessions = new Sessions(ctx.state.sessions, createBroadcast(ctx.state.clients));
    return Response.json(sessions.updateMetadata(sessionId, body));
  }));

  // Explicitly mark an idle session's completion read or unread.
  router.patch("/:sessionId/activity", withSessionNotFound(async (ctx) => {
    const sessionId = ctx.params.sessionId;
    const body = await parseBody(SessionActivityBody, ctx.req);
    const broadcast = createBroadcast(ctx.state.clients);
    const sessions = new Sessions(ctx.state.sessions, broadcast);
    try {
      sessions.setUnread(sessionId, body.unread);
    } catch (err) {
      if (err instanceof SessionNotFoundError) throw err;
      const message = err instanceof Error ? err.message : "Failed to update session activity";
      badRequest(message);
    }
    return Response.json({ ok: true });
  }));
}

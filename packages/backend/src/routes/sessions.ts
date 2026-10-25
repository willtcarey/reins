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
import { badRequest, conflict, HttpError } from "../errors.js";
import { SessionMoveConflict } from "../sessions/session-ownership.js";
import { PromptTooLargeError, SessionNotFoundError, type Sessions } from "../models/sessions.js";
import { SessionNodeRemovedError } from "../models/session.js";
import { parseDisplayCursor, type ClientPromptContent } from "../messages-store.js";
import { parseClientPromptContent } from "../session-attachments-store.js";
import { parseBody, parseOptionalBody } from "./validate.js";
import { withSessionNotFound } from "./session-errors.js";
import type { SessionMoveTarget } from "../sessions/session-ownership.js";

/** A node and whether the session can move there; `connected` is whether the node's link is open. */
export type SessionMoveTargetView = SessionMoveTarget & { connected: boolean };

export interface MessagePageQuery { before?: string; after?: string; limit?: number }
export type ActivitySnapshotItem = ReturnType<Sessions["activeSessions"]>[number];

const DEFAULT_MESSAGE_PAGE_LIMIT = 50;
const MAX_MESSAGE_PAGE_LIMIT = 200;

const SessionModelBody = Type.Object({
  runtimeType: Type.Optional(Type.String()),
  provider: Type.String(),
  modelId: Type.String(),
  thinkingLevel: Type.Optional(Type.String()),
});

/** `nodeId`: the node to move the session to (required: there is no release back to the server). */
const SessionMoveBody = Type.Object({
  nodeId: Type.String({ minLength: 1 }),
});

/** `instructions`: what the summary should focus on. */
const SessionCompactBody = Type.Object({
  instructions: Type.Optional(Type.String()),
});

/** `clientId` names the input, so a repeat converges on it; `message` is checked by `parseClientPromptContent`. */
const SessionSubmissionBody = Type.Object({
  clientId: Type.String({ minLength: 1 }),
  message: Type.Unknown(),
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
export type SessionMoveRequest = Static<typeof SessionMoveBody>;
export type SessionCompactRequest = Static<typeof SessionCompactBody>;
export type SessionMetadataUpdate = Static<typeof SessionMetadataBody>;
export interface SessionSubmissionRequest { clientId: string; message: ClientPromptContent }

export function registerSessionRoutes(router: RouterGroup<RouteContext>) {
  // List all sessions with non-null activity_state — for initial page-load
  // reconciliation without needing to expand every project first.
  router.get("/activity", (ctx) => {
    return Response.json(ctx.models.sessions.activeSessions());
  });

  router.put("/:sessionId/model", withSessionNotFound(async (ctx) => {
    const sessionId = ctx.params.sessionId;
    const body = await parseBody(SessionModelBody, ctx.req);

    const sessions = ctx.models.sessions;
    try {
      await sessions.setModel({ sessionId, ...body });
    } catch (err: unknown) {
      if (err instanceof SessionNotFoundError) throw err;
      if (err instanceof SessionNodeRemovedError) conflict(err.message);
      const message = err instanceof Error ? err.message : "Failed to update session model";
      badRequest(message);
    }
    const updated = sessions.getDetail(sessionId);
    if (!updated) throw new SessionNotFoundError();
    return Response.json(updated);
  }));

  router.get("/:sessionId/context", withSessionNotFound(async (ctx) => {
    const snapshot = await ctx.models.sessions.getContext(ctx.params.sessionId);
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

    const sessions = ctx.models.sessions;
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

    const data = ctx.models.sessions.getDetail(sessionId);
    if (!data) throw new SessionNotFoundError();

    return Response.json(data);
  }));

  router.post("/:sessionId/resume", withSessionNotFound(async (ctx) => {
    const sessionId = ctx.params.sessionId;
    const sessions = ctx.models.sessions;
    let started: boolean;
    try {
      ({ started } = await sessions.resume(sessionId));
    } catch (err: unknown) {
      if (err instanceof HttpError || err instanceof SessionNotFoundError) throw err;
      if (err instanceof SessionNodeRemovedError) conflict(err.message);
      badRequest(err instanceof Error ? err.message : "Failed to resume pending operation");
    }
    if (!started) conflict("The session has no interrupted operation to resume");
    return Response.json({ ok: true });
  }));

  // Each answers once Pi committed the input, not when its run ends.
  for (const op of ["prompt", "steer"] as const) {
    router.post(`/:sessionId/${op}`, withSessionNotFound(async (ctx) => {
      const body = await parseBody(SessionSubmissionBody, ctx.req);
      let content: ClientPromptContent;
      try { content = parseClientPromptContent(body.message); }
      catch (err: unknown) { badRequest(`Invalid message: ${err instanceof Error ? err.message : String(err)}`); }
      try {
        await ctx.models.sessions.submit(ctx.params.sessionId, { op, content, clientId: body.clientId });
      } catch (err: unknown) {
        if (err instanceof SessionNotFoundError) throw err;
        if (err instanceof PromptTooLargeError) throw new HttpError(413, err.message);
        if (err instanceof SessionNodeRemovedError) conflict(err.message);
        // The admission's own failure (an unknown model, a missing attachment), as the sender sees it. Not
        // a 503, which the browser would retry.
        badRequest(err instanceof Error ? err.message : `Failed to ${op}`);
      }
      return Response.json({ ok: true });
    }));
  }

  router.post("/:sessionId/abort", withSessionNotFound(async (ctx) => {
    return Response.json(await ctx.models.sessions.abort(ctx.params.sessionId));
  }));

  // Answers once the compaction started; 409 while the session is running or has nothing to compact.
  router.post("/:sessionId/compact", withSessionNotFound(async (ctx) => {
    const body = await parseOptionalBody(SessionCompactBody, ctx.req);
    try {
      await ctx.models.sessions.compact(ctx.params.sessionId, body);
    } catch (err: unknown) {
      if (err instanceof Error && (err.name === "CompactionRefusedError" || err instanceof SessionNodeRemovedError)) conflict(err.message);
      throw err;
    }
    return Response.json({ ok: true });
  }));

  // Every node, eligible move targets first; ineligible ones say why (`current`, `no_source`).
  router.get("/:sessionId/move-targets", withSessionNotFound(async (ctx) => {
    const targets = ctx.models.sessions.moveTargets(ctx.params.sessionId);
    return Response.json(targets.map((target): SessionMoveTargetView => ({ ...target, connected: ctx.state.nodes.get(target.nodeId).connected })));
  }));

  // Move the idle session to a node (re-points its source and closes its live runtime).
  // Returns its placement; 409 while it is busy or the node has no source for its project.
  router.post("/:sessionId/move", withSessionNotFound(async (ctx) => {
    const body = await parseBody(SessionMoveBody, ctx.req);
    const sessions = ctx.models.sessions;
    try {
      return Response.json(await sessions.move(ctx.params.sessionId, body.nodeId));
    } catch (err) {
      if (err instanceof SessionMoveConflict) conflict(err.message);
      throw err;
    }
  }));

  router.patch("/:sessionId/metadata", withSessionNotFound(async (ctx) => {
    const sessionId = ctx.params.sessionId;
    const body = await parseBody(SessionMetadataBody, ctx.req);
    const sessions = ctx.models.sessions;
    return Response.json(sessions.updateMetadata(sessionId, body));
  }));

  // Explicitly mark an idle session's completion read or unread.
  router.patch("/:sessionId/activity", withSessionNotFound(async (ctx) => {
    const sessionId = ctx.params.sessionId;
    const body = await parseBody(SessionActivityBody, ctx.req);
    const sessions = ctx.models.sessions;
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

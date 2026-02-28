/**
 * Session Lookup Route (top-level, not project-scoped)
 *
 * Provides a top-level endpoint to fetch a session by its globally-unique ID.
 * Returns the same data as the project-scoped endpoint, plus `project_id`
 * so the frontend can derive the active project context from a session URL.
 */

import type { RouterGroup } from "../router.js";
import type { RouteContext } from "../router.js";
import { getSession as dbGetSession } from "../session-store.js";
import { serializeSession, serializeSessionFromDb } from "../sessions.js";

export function registerSessionLookupRoutes(router: RouterGroup<RouteContext>) {
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

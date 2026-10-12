/**
 * Health Check Route
 */

import type { RouterGroup } from "../router.js";
import { API } from "../api-paths.js";
import { activeSessionIds } from "../models/session-activity.js";
import { listNodes } from "../node-store.js";

/** Active sessions: running, or with input being admitted by their runtime (`sessionActivity`). `nodes` lists every node with whether it is connected (a node runs separately and may
 * be down or reconnecting). */
export function registerHealthRoutes(router: RouterGroup) {
  router.get(API.health, async (ctx) => {
    const activeSessions = activeSessionIds(ctx.state.process.sessions).length;
    return Response.json({
      status: "ok",
      activeSessions,
      streaming: activeSessions > 0,
      nodes: listNodes().map(({ id, name }) => ({ id, name, connected: ctx.state.process.nodes.get(id).connected })),
    });
  });
}

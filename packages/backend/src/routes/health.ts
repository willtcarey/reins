/**
 * Health Check Route
 */

import type { RouterGroup } from "../router.js";
import { API } from "../api-paths.js";
import { activeSessionIds } from "../sessions/session-runs.js";
import { listNodes } from "../node-store.js";

/** Sessions run on nodes: activity comes from server projections (running or with queued input), never
 * from a runtime. `nodes` lists every node with whether it is connected (a node runs separately and may
 * be down or reconnecting). */
export function registerHealthRoutes(router: RouterGroup) {
  router.get(API.health, async (ctx) => {
    const activeSessions = activeSessionIds().length;
    return Response.json({
      status: "ok",
      activeSessions,
      streaming: activeSessions > 0,
      nodes: listNodes().map(node => ({ ...node, connected: ctx.state.nodes.connected(node.id) })),
    });
  });
}

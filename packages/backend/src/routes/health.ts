/**
 * Health Check Route
 */

import type { RouterGroup } from "../router.js";
import { API } from "../api-paths.js";
import { activeNodeSessionIds } from "../models/node-session-activity.js";
import { internalNodeConnected } from "../runtimes/internal-node.js";

/** Sessions run on nodes: activity comes from server projections (running or with queued input), never
 * from a runtime. `internalNode.connected` reports whether the node process is linked (it runs
 * separately and may be down or reconnecting). */
export function registerHealthRoutes(router: RouterGroup) {
  router.get(API.health, async (ctx) => {
    const activeSessions = activeNodeSessionIds().length;
    return Response.json({
      status: "ok",
      activeSessions,
      streaming: activeSessions > 0,
      internalNode: { connected: internalNodeConnected(ctx.state) },
    });
  });
}

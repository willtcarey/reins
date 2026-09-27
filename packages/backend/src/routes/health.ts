/**
 * Health Check Route
 */

import type { RouterGroup } from "../router.js";
import { API } from "../api-paths.js";
import { activeNodeSessionIds } from "../models/node-session-activity.js";
import { internalNodeConnected } from "../runtimes/internal-node.js";

/** Legacy server-owned sessions report their open in-memory runtimes; node-owned sessions report
 * activity from server projections (running or with queued input), never from a node runtime.
 * `internalNode.connected` reports whether the node process is linked (it runs separately and may be
 * down or reconnecting). */
export function registerHealthRoutes(router: RouterGroup) {
  router.get(API.health, async (ctx) => {
    const activeNodeSessions = activeNodeSessionIds().length;
    const streaming = [...ctx.state.sessions.values()].some((m) => m.runtime.isStreaming()) || activeNodeSessions > 0;
    return Response.json({
      status: "ok",
      activeSessions: ctx.state.sessions.size + activeNodeSessions,
      streaming,
      internalNode: { connected: internalNodeConnected(ctx.state) },
    });
  });
}

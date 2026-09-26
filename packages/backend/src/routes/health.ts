/**
 * Health Check Route
 */

import type { RouterGroup } from "../router.js";
import { API } from "../api-paths.js";
import { installedInternalNode } from "../runtimes/internal-node.js";

export function registerHealthRoutes(router: RouterGroup) {
  router.get(API.health, async (ctx) => {
    const node = installedInternalNode(ctx.state);
    const streaming = [...ctx.state.sessions.values()].some((m) => m.runtime.isStreaming()) || (node?.anyStreaming() ?? false);
    return Response.json({
      status: "ok",
      activeSessions: ctx.state.sessions.size + (node?.runtimeCount() ?? 0),
      streaming,
    });
  });
}

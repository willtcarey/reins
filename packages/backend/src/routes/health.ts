/**
 * Health Check Route
 */

import type { RouterGroup, RouteContext } from "../router.js";
import { API } from "../api-paths.js";

export function registerHealthRoutes(router: RouterGroup) {
  router.get(API.health, async (ctx: RouteContext) => {
    const streaming = [...ctx.state.sessions.values()].some(
      (m) => m.session.isStreaming,
    );
    return Response.json({
      status: "ok",
      activeSessions: ctx.state.sessions.size,
      streaming,
    });
  });
}

/**
 * Health Check Route
 */

import type { RouterGroup } from "../router.js";
import { API } from "../api-paths.js";
import { getPiSession } from "../runtimes/pi/runtime.js";

export function registerHealthRoutes(router: RouterGroup) {
  router.get(API.health, async (ctx) => {
    const streaming = [...ctx.state.sessions.values()].some(
      (m) => getPiSession(m.runtime).isStreaming,
    );
    return Response.json({
      status: "ok",
      activeSessions: ctx.state.sessions.size,
      streaming,
    });
  });
}

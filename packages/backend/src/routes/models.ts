/**
 * Models Route
 *
 * Discovery endpoint for available AI providers and their models.
 * Returns provider metadata including key configuration status.
 */

import type { RouterGroup, RouteContext } from "../router.js";
import { API } from "../api-paths.js";
import { listRuntimeProviders } from "../runtimes/pi/model-catalog.js";

export function registerModelsRoutes(router: RouterGroup) {
  router.get(API.models, async (_ctx: RouteContext) => {
    return Response.json(await listRuntimeProviders());
  });
}

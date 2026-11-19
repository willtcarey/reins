/**
 * Models Route
 *
 * Discovery endpoint for available AI providers and their models.
 * Returns provider metadata including key configuration status.
 */

import type { RouterGroup, RouteContext } from "../router.js";
import { API } from "../api-paths.js";
import { listRuntimeProviders } from "../pi/model-catalog.js";
import { listDecisionModels } from "../sdk-host/decisions.js";

export function registerModelsRoutes(router: RouterGroup) {
  router.get(API.models, async (ctx: RouteContext) => {
    return Response.json(await listRuntimeProviders(ctx.models.credentials));
  });

  /** What Settings offers as the default decision model: `reins.decisions.list()`. */
  router.get(API.decisionModels, async (ctx: RouteContext) => {
    return Response.json(await listDecisionModels(ctx.models, ctx.req.signal));
  });
}

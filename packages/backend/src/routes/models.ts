/**
 * Models Route
 *
 * Discovery endpoint for available AI providers and their models.
 * Returns provider metadata including key configuration status.
 */

import type { RouterGroup, RouteContext } from "../router.js";
import { API } from "../api-paths.js";
import { buildProviderList } from "../pi/models-registry.js";

export type { ProviderInfo, ModelInfo } from "../pi/models-registry.js";

export function registerModelsRoutes(router: RouterGroup) {
  router.get(API.models, async (_ctx: RouteContext) => {
    const result = buildProviderList();
    return Response.json(result);
  });
}

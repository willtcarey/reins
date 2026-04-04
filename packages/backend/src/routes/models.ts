/**
 * Models Route
 *
 * Discovery endpoint for available AI providers and their models.
 * Returns provider metadata including key configuration status.
 */

import type { RouterGroup, RouteContext } from "../router.js";
import { API } from "../api-paths.js";
import { buildProviderList } from "../scripting/models.js";

export type { ProviderInfo, ModelInfo } from "../scripting/models.js";

export function registerModelsRoutes(router: RouterGroup) {
  router.get(API.models, async (ctx: RouteContext) => {
    const result = buildProviderList(ctx.state.encryptionSecret);
    return Response.json(result);
  });
}

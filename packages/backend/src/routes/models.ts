/**
 * Models Route
 *
 * Discovery endpoint for available AI providers and their models.
 * Returns provider metadata including key configuration status.
 */

import type { RouterGroup, RouteContext } from "../router.js";
import { API } from "../api-paths.js";
import { ensureRuntimeAdapterRegistered, listAllRuntimeProviders } from "../runtimes/registry.js";

export type { RuntimeProviderInfo as ProviderInfo, ModelInfo } from "../runtimes/registry.js";

export function registerModelsRoutes(router: RouterGroup) {
  router.get(API.models, async (_ctx: RouteContext) => {
    await ensureRuntimeAdapterRegistered("pi");
    const result = await listAllRuntimeProviders();
    return Response.json(result);
  });
}

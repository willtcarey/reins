/**
 * Palette Routes
 *
 * Returns all sessions across projects for the quick-open palette.
 */

import type { RouterGroup } from "../router.js";
import type { RouteContext } from "../router.js";
import { API } from "../api-paths.js";
import { listPaletteItems } from "../session-store.js";

export function registerPaletteRoutes(router: RouterGroup<RouteContext>) {
  router.get(API.palette, async () => {
    const items = listPaletteItems();
    return Response.json(items);
  });
}

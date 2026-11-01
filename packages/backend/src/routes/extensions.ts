/**
 * Extension Routes (docs/dev/server-sdk.md *Routes*): what each extension registered through the server SDK.
 *
 *   GET /api/extensions               — the host's report of each extension (`ExtensionView[]`): its health, what
 *                                       it registered and what it stores; the host's route, not an extension's
 *   *  /api/extensions/:extension/*   — its HTTP API (`reins.routes.api`): 404 JSON when no route matches
 *   *  /extensions/:extension/*       — its pages for the browser (`reins.routes.pages`): 404 text
 *
 * The app's extensions are asked at each request, so a reload's new routes answer at once.
 */

import type { RouterGroup } from "../router.js";
import { API } from "../api-paths.js";
import type { RouteScope } from "../extensions/host.js";
import { notFound } from "../errors.js";

const METHODS = ["get", "post", "put", "patch", "delete"] as const;

export function registerExtensionRoutes(router: RouterGroup) {
  router.get(API.extensionsApi, (ctx) => Response.json(ctx.state.extensions.list()));
  const mount = (scope: RouteScope, prefix: string) => {
    for (const method of METHODS) {
      router[method](`${prefix}/:extension/*`, async (ctx) => {
        const response = await ctx.state.extensions.handle(scope, ctx.req, ctx.url);
        if (response) return response;
        if (scope === "api") notFound(`No API route ${ctx.req.method} ${ctx.url.pathname}`);
        return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
      });
    }
  };
  mount("api", API.extensionsApi);
  mount("pages", API.extensionPages);
}

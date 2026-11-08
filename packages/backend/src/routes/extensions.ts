/**
 * Extension routes (docs/dev/extensions-overview.md):
 *
 *   *  /api/extensions/:extension/*   — its HTTP API (`reins.http.handle`): 404 JSON when no route matches
 *   *  /extensions/:extension/*       — its pages for the browser (`reins.http.page`): 404 text
 *
 *   GET    /api/installed-extensions                — the report (`ExtensionView[]`): each one's state, what it
 *                                                     registered and what it stores
 *   POST   /api/installed-extensions                — { path }: adds the extension in that directory and loads it
 *   PATCH  /api/installed-extensions/:name          — { enabled }: turns it on or off, built-in or added
 *   POST   /api/installed-extensions/:name/reload   — loads an added one's files anew
 *   POST   /api/installed-extensions/:name/frontend — { script, error }: a browser's report of how its frontend part loaded
 *   DELETE /api/installed-extensions/:name          — unloads an added one and forgets it (its data stays)
 *   GET    /extension-bundles/:name/:build/*        — a file of an added extension's frontend directory
 *
 * The app's extensions are asked at each request, so a reload's new routes answer at once.
 */

import type { RouterGroup } from "../router.js";
import { API } from "../api-paths.js";
import type { RouteScope } from "../extension-system/host.js";
import { HttpError, notFound } from "../errors.js";
import { Type } from "@sinclair/typebox";
import { BUNDLES_PATH, ExtensionsError } from "../extension-system/extensions.js";
import { parseBody } from "./validate.js";

const PathBody = Type.Object({ path: Type.String({ minLength: 1 }) });
const EnabledBody = Type.Object({ enabled: Type.Boolean() });
const FrontendReport = Type.Object({ script: Type.String({ maxLength: 500 }), error: Type.Union([Type.String({ maxLength: 8000 }), Type.Null()]) });

async function refusing<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ExtensionsError) throw new HttpError(error.status, error.message);
    throw error;
  }
}

const METHODS = ["get", "post", "put", "patch", "delete"] as const;

export function registerExtensionRoutes(router: RouterGroup) {
  router.get(API.installedExtensions, (ctx) => Response.json(ctx.state.extensions.list()));
  const mount = (scope: RouteScope, prefix: string) => {
    for (const method of METHODS) {
      router[method](`${prefix}/:extension/*`, async (ctx) => {
        const response = await ctx.state.extensions.host.handle(scope, ctx.req, ctx.url);
        if (response) return response;
        if (scope === "api") notFound(`No API route ${ctx.req.method} ${ctx.url.pathname}`);
        return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
      });
    }
  };
  mount("api", API.extensionsApi);
  mount("pages", API.extensionPages);

  router.post(API.installedExtensions, async (ctx) => {
    const { path } = await parseBody(PathBody, ctx.req);
    return Response.json(await refusing(() => ctx.state.extensions.add(path)), { status: 201 });
  });
  router.patch(`${API.installedExtensions}/:name`, async (ctx) => {
    const { enabled } = await parseBody(EnabledBody, ctx.req);
    await refusing(() => ctx.state.extensions.setEnabled(ctx.params.name!, enabled));
    return new Response(null, { status: 204 });
  });
  router.post(`${API.installedExtensions}/:name/reload`, async (ctx) =>
    Response.json(await refusing(() => ctx.state.extensions.reload(ctx.params.name!))));
  router.post(`${API.installedExtensions}/:name/frontend`, async (ctx) => {
    const { script, error } = await parseBody(FrontendReport, ctx.req);
    ctx.state.extensions.reportFrontend(ctx.params.name!, script, error);
    return new Response(null, { status: 204 });
  });
  router.delete(`${API.installedExtensions}/:name`, async (ctx) => {
    await refusing(() => ctx.state.extensions.remove(ctx.params.name!));
    return new Response(null, { status: 204 });
  });
  router.get(`${BUNDLES_PATH}/:name/:build/*`, async (ctx) => {
    const prefix = `${BUNDLES_PATH}/${ctx.params.name}/${ctx.params.build}/`;
    let path: string | null = null;
    try {
      path = await ctx.state.extensions.bundleFile(ctx.params.name!, ctx.params.build!, decodeURIComponent(ctx.url.pathname.slice(prefix.length)));
    } catch {
      // A path that does not decode is none of its files.
    }
    if (!path) return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    // An installed build never changes, and its URL has its build ID.
    return new Response(Bun.file(path), { headers: { "Cache-Control": "public, max-age=31536000, immutable" } });
  });
}

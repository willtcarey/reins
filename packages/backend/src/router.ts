/**
 * Lightweight Router
 *
 * URLPattern-based routing with middleware support.
 * No external dependencies — uses the web-standard URLPattern built into Bun.
 *
 * Usage:
 *   const router = createRouter();
 *   router.get("/api/things", handler);
 *   router.group("/api/things/:id", middleware, (r) => {
 *     r.get("/sub", subHandler);
 *   });
 *   const response = await router.handle(req, state);
 */

import type { ServerState } from "./state.js";
import { logger } from "./logger.js";
import { HttpError } from "./errors.js";

// ---- Types -----------------------------------------------------------------

export interface RouteContext {
  req: Request;
  url: URL;
  params: Record<string, string>;
  state: ServerState;
}

export type RouteHandler<Ctx extends RouteContext = RouteContext> = (ctx: Ctx) => Promise<Response> | Response;
export interface Middleware<Ext extends object = {}> {
  (ctx: any): Promise<void> | void;
  readonly _contextExtension?: Ext;
}

interface Route {
  method: string;
  pattern: URLPattern;
  handler: RouteHandler<any>;
  middlewares: Middleware[];
}

export interface RouterGroup<Ctx extends RouteContext = RouteContext> {
  get(path: string, handler: RouteHandler<Ctx>): void;
  post(path: string, handler: RouteHandler<Ctx>): void;
  put(path: string, handler: RouteHandler<Ctx>): void;
  patch(path: string, handler: RouteHandler<Ctx>): void;
  delete(path: string, handler: RouteHandler<Ctx>): void;
  group(prefix: string, cb: (r: RouterGroup<Ctx>) => void): void;
  group<Ext extends object>(
    prefix: string,
    middleware: Middleware<Ext>,
    cb: (r: RouterGroup<Ctx & Ext>) => void,
  ): void;
  group<Ext extends object>(
    prefix: string,
    ...args: [...Middleware<Ext>[], (r: RouterGroup<Ctx & Ext>) => void]
  ): void;
}

// ---- Router ----------------------------------------------------------------

export function createRouter(): RouterGroup & { handle: (req: Request, state: ServerState) => Promise<Response | null> } {
  const routes: Route[] = [];

  function addRoute(method: string, fullPath: string, handler: RouteHandler, middlewares: Middleware[]) {
    const pattern = new URLPattern({ pathname: fullPath });
    routes.push({ method, pattern, handler, middlewares });
  }

  function createGroup(prefix: string, parentMiddlewares: Middleware[]): RouterGroup<any> {
    const group: RouterGroup<any> = {
      get(path, handler)    { addRoute("GET",    prefix + path, handler, parentMiddlewares); },
      post(path, handler)   { addRoute("POST",   prefix + path, handler, parentMiddlewares); },
      put(path, handler)    { addRoute("PUT",    prefix + path, handler, parentMiddlewares); },
      patch(path, handler)  { addRoute("PATCH",  prefix + path, handler, parentMiddlewares); },
      delete(path, handler) { addRoute("DELETE", prefix + path, handler, parentMiddlewares); },

      group(subPrefix: string, ...args: [...Middleware[], (r: RouterGroup<RouteContext>) => void]) {
        const registerFn = args.pop();
        const middlewares: Middleware[] = args;
        const sub = createGroup(prefix + subPrefix, [...parentMiddlewares, ...middlewares]);
        if (typeof registerFn === "function") registerFn(sub);
      },
    };
    return group;
  }

  const root = createGroup("", []);

  async function handle(req: Request, state: ServerState): Promise<Response | null> {
    const url = new URL(req.url);

    for (const route of routes) {
      if (route.method !== req.method) continue;
      const match = route.pattern.exec(url);
      if (!match) continue;

      const params: Record<string, string> = {};
      for (const [key, value] of Object.entries(match.pathname.groups)) {
        if (value !== undefined) params[key] = decodeURIComponent(value);
      }

      const ctx: RouteContext = { req, url, params, state };

      try {
        // Run middlewares
        for (const mw of route.middlewares) {
          await mw(ctx);
        }
        // Run handler
        return await route.handler(ctx);
      } catch (err: any) {
        if (err instanceof HttpError) {
          return Response.json({ error: err.message }, { status: err.status });
        }
        logger.error(`Error in ${req.method} ${url.pathname}:`, err);
        return Response.json({ error: err.message ?? "Internal server error" }, { status: 500 });
      }
    }

    return null; // No route matched
  }

  return { ...root, handle };
}

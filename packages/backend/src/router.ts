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
import type { ProjectModel } from "./models/projects.js";
import { HttpError } from "./errors.js";

// ---- Types -----------------------------------------------------------------

export interface RouteContext {
  req: Request;
  url: URL;
  params: Record<string, string>;
  state: ServerState;
  project?: ProjectModel;
}

export type RouteHandler = (ctx: RouteContext) => Promise<Response> | Response;
export type Middleware = (ctx: RouteContext) => Promise<void> | void;

interface Route {
  method: string;
  pattern: URLPattern;
  handler: RouteHandler;
  middlewares: Middleware[];
}

export interface RouterGroup {
  get(path: string, handler: RouteHandler): void;
  post(path: string, handler: RouteHandler): void;
  patch(path: string, handler: RouteHandler): void;
  delete(path: string, handler: RouteHandler): void;
  group(prefix: string, ...args: [...Middleware[], (r: RouterGroup) => void]): void;
}

// ---- Router ----------------------------------------------------------------

export function createRouter(): RouterGroup & { handle: (req: Request, state: ServerState) => Promise<Response | null> } {
  const routes: Route[] = [];

  function addRoute(method: string, fullPath: string, handler: RouteHandler, middlewares: Middleware[]) {
    const pattern = new URLPattern({ pathname: fullPath });
    routes.push({ method, pattern, handler, middlewares });
  }

  function createGroup(prefix: string, parentMiddlewares: Middleware[]): RouterGroup {
    const group: RouterGroup = {
      get(path, handler)    { addRoute("GET",    prefix + path, handler, parentMiddlewares); },
      post(path, handler)   { addRoute("POST",   prefix + path, handler, parentMiddlewares); },
      patch(path, handler)  { addRoute("PATCH",  prefix + path, handler, parentMiddlewares); },
      delete(path, handler) { addRoute("DELETE", prefix + path, handler, parentMiddlewares); },

      group(subPrefix, ...args) {
        const registerFn = args.pop() as (r: RouterGroup) => void;
        const middlewares = args as Middleware[];
        const sub = createGroup(prefix + subPrefix, [...parentMiddlewares, ...middlewares]);
        registerFn(sub);
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
        if (value !== undefined) params[key] = decodeURIComponent(value as string);
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
        console.error(`Error in ${req.method} ${url.pathname}:`, err);
        return Response.json({ error: err.message ?? "Internal server error" }, { status: 500 });
      }
    }

    return null; // No route matched
  }

  return { ...root, handle };
}

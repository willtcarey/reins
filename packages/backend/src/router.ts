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
 *   router.websocket("/ws", ({ req, server }) => server.upgrade(req, { data: {} }) ? undefined : refusal());
 *   const response = await router.handle(req, state, server);
 */

import type { ServerState, UpgradeServer } from "./state.js";
import { Models } from "./models/models.js";
import { logger } from "./logger.js";
import { HttpError, isNodeUnavailable } from "./errors.js";

// ---- Types -----------------------------------------------------------------

export interface RouteContext {
  req: Request;
  url: URL;
  params: Record<string, string>;
  state: ServerState;
  /** The request's models, built from `state`. */
  models: Models;
  /** The HTTP server the request reached, to upgrade it to a WebSocket (`websocket` routes). */
  server: UpgradeServer;
}

export type RouteHandler<Ctx extends RouteContext = RouteContext> = (ctx: Ctx) => Promise<Response> | Response;
/** A `websocket` route's handler: undefined once it upgraded the request (Bun answers it), else its
 * refusal. */
export type WebSocketRouteHandler<Ctx extends RouteContext = RouteContext> = (ctx: Ctx) => Promise<Response | undefined> | Response | undefined;
export interface Middleware<Ext extends object = {}> {
  (ctx: any): Promise<void> | void;
  readonly _contextExtension?: Ext;
}

interface Route {
  method: string;
  pattern: URLPattern;
  handler: WebSocketRouteHandler<any>;
  middlewares: Middleware[];
}

export interface RouterGroup<Ctx extends RouteContext = RouteContext> {
  get(path: string, handler: RouteHandler<Ctx>): void;
  post(path: string, handler: RouteHandler<Ctx>): void;
  put(path: string, handler: RouteHandler<Ctx>): void;
  patch(path: string, handler: RouteHandler<Ctx>): void;
  delete(path: string, handler: RouteHandler<Ctx>): void;
  /** A GET route that may upgrade the request to a WebSocket. */
  websocket(path: string, handler: WebSocketRouteHandler<Ctx>): void;
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

/** `handle`'s server when its caller has none: it upgrades nothing. */
const NO_UPGRADES: UpgradeServer = { upgrade: () => false };

export interface Router extends RouterGroup {
  /** Answers `req` from the route it matches: its response, undefined once a `websocket` route upgraded
   * it (Bun's fetch then returns undefined), null when no route matches. Without a `server` no upgrade
   * succeeds. */
  handle(req: Request, state: ServerState, server?: UpgradeServer): Promise<Response | undefined | null>;
}

export function createRouter(): Router {
  const routes: Route[] = [];

  function addRoute(method: string, fullPath: string, handler: WebSocketRouteHandler, middlewares: Middleware[]) {
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
      websocket(path, handler) { addRoute("GET", prefix + path, handler, parentMiddlewares); },

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

  async function handle(req: Request, state: ServerState, server = NO_UPGRADES): Promise<Response | undefined | null> {
    const url = new URL(req.url);

    for (const route of routes) {
      if (route.method !== req.method) continue;
      const match = route.pattern.exec(url);
      if (!match) continue;

      const params: Record<string, string> = {};
      for (const [key, value] of Object.entries(match.pathname.groups)) {
        if (value !== undefined) params[key] = decodeURIComponent(value);
      }

      const ctx: RouteContext = { req, url, params, state, models: new Models(state), server };

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
        if (isNodeUnavailable(err)) {
          return Response.json({ error: err.message }, { status: 503 });
        }
        logger.error(`Error in ${req.method} ${url.pathname}:`, err);
        return Response.json({ error: err.message ?? "Internal server error" }, { status: 500 });
      }
    }

    return null; // No route matched
  }

  return { ...root, handle };
}

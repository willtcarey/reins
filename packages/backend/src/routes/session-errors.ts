import { notFound } from "../errors.js";
import { SessionNotFoundError } from "../models/sessions.js";
import type { RouteContext, RouteHandler } from "../router.js";

/** Translate session lookup failures at the HTTP boundary. */
export function withSessionNotFound<Ctx extends RouteContext>(handler: RouteHandler<Ctx>): RouteHandler<Ctx> {
  return async (ctx) => {
    try {
      return await handler(ctx);
    } catch (err) {
      if (err instanceof SessionNotFoundError) notFound(err.message);
      throw err;
    }
  };
}

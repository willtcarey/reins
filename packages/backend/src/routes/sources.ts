/**
 * Source Routes (project-scoped)
 *
 *   GET   /sources            — the project's sources (checkouts on nodes), its default one first
 *   PATCH /sources/:sourceId  — move a source to another path on its node
 */

import { Type, type Static } from "@sinclair/typebox";
import type { RouterGroup } from "../router.js";
import type { ProjectRouteContext } from "./index.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { CheckoutNotFoundError, DuplicateSourceError, listProjectSources, moveSource, SourceNotFoundError } from "../models/sources.js";
import { parseBody, parseIntParam } from "./validate.js";

const UpdateSourceBody = Type.Object({
  path: Type.String({ minLength: 1, pattern: "\\S" }),
});

export type SourceUpdate = Static<typeof UpdateSourceBody>;

export function registerSourceRoutes(router: RouterGroup<ProjectRouteContext>) {
  router.get("/sources", async (ctx) => {
    return Response.json(listProjectSources(ctx.project.projectId, ctx.state.nodes));
  });

  /** The new path is checked on the source's node first: a path that is not a directory there is a 400. */
  router.patch("/sources/:sourceId", async (ctx) => {
    const sourceId = parseIntParam(ctx.params, "sourceId");
    const body = await parseBody(UpdateSourceBody, ctx.req);
    try {
      await moveSource(ctx.project.projectId, sourceId, body.path.trim(), ctx.state.nodes);
      return Response.json(listProjectSources(ctx.project.projectId, ctx.state.nodes).find((source) => source.id === sourceId));
    } catch (err) {
      if (err instanceof SourceNotFoundError) notFound(err.message);
      if (err instanceof CheckoutNotFoundError) badRequest(err.message);
      if (err instanceof DuplicateSourceError) conflict(err.message);
      throw err;
    }
  });
}

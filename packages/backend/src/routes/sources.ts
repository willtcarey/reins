/**
 * Source Routes (project-scoped)
 *
 *   GET   /sources            — the project's sources (checkouts on nodes), its default one first
 *   POST  /sources            — add a checkout of the project on a node ({nodeId, path}): 201, the source
 *                               (400: unknown node, or a path that is not a directory there; 409: a project
 *                               has that checkout, or the project already has one on that node; 503: the
 *                               node is offline)
 *   PATCH /sources/:sourceId  — move a source to another path on its node
 *
 * Browsers hear of a node's new or moved source through `node_updated` (`Nodes.publish`).
 */

import { Type, type Static } from "@sinclair/typebox";
import type { RouterGroup } from "../router.js";
import type { ProjectRouteContext } from "./index.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { CheckoutNotFoundError, createSource, DuplicateSourceError, listProjectSources, moveSource, SourceNotFoundError } from "../models/sources.js";
import { NodeNotFoundError } from "../models/nodes.js";
import { parseBody, parseIntParam } from "./validate.js";

const UpdateSourceBody = Type.Object({
  path: Type.String({ minLength: 1, pattern: "\\S" }),
});

const CreateSourceBody = Type.Object({
  nodeId: Type.String({ minLength: 1 }),
  path: Type.String({ minLength: 1, pattern: "\\S" }),
});

export type SourceUpdate = Static<typeof UpdateSourceBody>;
export type SourceInput = Static<typeof CreateSourceBody>;

export function registerSourceRoutes(router: RouterGroup<ProjectRouteContext>) {
  router.get("/sources", async (ctx) => {
    return Response.json(listProjectSources(ctx.project.projectId, ctx.state.nodes));
  });

  /** The path is checked on the node first: one that is not a directory there is a 400. */
  router.post("/sources", async (ctx) => {
    const body = await parseBody(CreateSourceBody, ctx.req);
    try {
      const source = await createSource(ctx.project.projectId, body.nodeId, body.path.trim(), ctx.models.nodes);
      return Response.json(listProjectSources(ctx.project.projectId, ctx.state.nodes).find((view) => view.id === source.id), { status: 201 });
    } catch (err) {
      if (err instanceof NodeNotFoundError || err instanceof CheckoutNotFoundError) badRequest(err.message);
      if (err instanceof DuplicateSourceError) conflict(err.message);
      throw err;
    }
  });

  /** The new path is checked on the source's node first: a path that is not a directory there is a 400. */
  router.patch("/sources/:sourceId", async (ctx) => {
    const sourceId = parseIntParam(ctx.params, "sourceId");
    const body = await parseBody(UpdateSourceBody, ctx.req);
    try {
      await moveSource(ctx.project.projectId, sourceId, body.path.trim(), ctx.models.nodes);
      return Response.json(listProjectSources(ctx.project.projectId, ctx.state.nodes).find((source) => source.id === sourceId));
    } catch (err) {
      if (err instanceof SourceNotFoundError) notFound(err.message);
      if (err instanceof CheckoutNotFoundError) badRequest(err.message);
      if (err instanceof DuplicateSourceError) conflict(err.message);
      throw err;
    }
  });
}

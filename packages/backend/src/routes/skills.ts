/**
 * Skills Routes
 *
 * Lists the skills a session can invoke, for the frontend's `/name` suggestions: `GET
 * /api/nodes/:nodeId/skills?path=` those of a directory on a node (its `~/.agents` and the directory's), as
 * a session's runtime there discovers them (`skillsAt`): a session's composer asks for its placement, the
 * new session page for the location chosen. When the node does not answer in time, `available` is false
 * and none are listed: suggestions are best effort.
 */

import type { RouterGroup } from "../router.js";
import { API } from "../api-paths.js";
import { badRequest, notFound } from "../errors.js";
import { CheckoutNotFoundError, skillsAt } from "../models/sources.js";
import { NodeNotFoundError } from "../models/nodes.js";

/** A skill as suggestions show it. */
export interface InjectedSkillInfo { name: string; description: string }
/** `available`: the node answered, so `skills` are all of them. */
export interface SkillsListResponse { skills: InjectedSkillInfo[]; available: boolean }

export function registerSkillRoutes(router: RouterGroup) {
  router.get(`${API.nodes}/:nodeId/skills`, async (ctx) => {
    const path = ctx.url.searchParams.get("path");
    if (!path) badRequest("Query parameter 'path' is required");
    try {
      return Response.json(await skillsAt(ctx.params.nodeId!, path, ctx.models.nodes) satisfies SkillsListResponse);
    } catch (error) {
      if (error instanceof NodeNotFoundError) notFound(error.message);
      if (error instanceof CheckoutNotFoundError) badRequest(error.message);
      throw error;
    }
  });
}

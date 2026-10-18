/**
 * Skills Routes (project-scoped)
 *
 * Lists the skills a project's sessions can invoke, for the frontend's `/name` suggestions: those of the
 * request's source's node and checkout, as a session's runtime discovers them (`SourceModel.listSkills`).
 * When the source's node does not answer in time, `available` is false and none are listed: suggestions
 * are best effort.
 */

import type { RouterGroup } from "../router.js";
import type { ProjectRouteContext } from "./index.js";

/** A skill as suggestions show it. */
export interface InjectedSkillInfo { name: string; description: string }
/** `available`: the node answered, so `skills` are all of them. */
export interface SkillsListResponse { skills: InjectedSkillInfo[]; available: boolean }

export function registerSkillRoutes(router: RouterGroup<ProjectRouteContext>) {
  router.get("/skills", async (ctx) => {
    return Response.json(await ctx.project.source.listSkills() satisfies SkillsListResponse);
  });
}

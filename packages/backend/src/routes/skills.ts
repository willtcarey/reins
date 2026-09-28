/**
 * Skills Routes (project-scoped)
 *
 * Lists the skills a project's sessions can invoke, for the frontend's `/name` suggestions. Skills live
 * in a source checkout on a node, so the server asks the node of the project's default source
 * (`skills.list`, the same discovery the node uses to expand a prompt). When that node is not
 * connected or does not answer in time the list is empty and `available` is false: suggestions are
 * best effort and the frontend keeps what it had.
 */

import type { RouterGroup } from "../router.js";
import type { ProjectRouteContext } from "./index.js";
import { defaultSource } from "../node-store.js";
import { logger } from "../logger.js";

/** A skill as suggestions show it (the `skills.list` fields). */
export interface InjectedSkillInfo { name: string; description: string }
export interface SkillsListResponse { skills: InjectedSkillInfo[]; available: boolean }

export function registerSkillRoutes(router: RouterGroup<ProjectRouteContext>) {
  router.get("/skills", async (ctx) => {
    const source = defaultSource(ctx.project.projectId);
    if (!source) return Response.json({ skills: [], available: false } satisfies SkillsListResponse);
    try {
      const skills = await ctx.state.nodes.listSkills(source.node_id, { sourceId: source.id, cwd: source.path });
      return Response.json({ skills, available: true } satisfies SkillsListResponse);
    } catch (error) {
      logger.debug(`Skills of source ${source.id} unavailable from node ${source.node_id}:`, error instanceof Error ? error.message : error);
      return Response.json({ skills: [], available: false } satisfies SkillsListResponse);
    }
  });
}

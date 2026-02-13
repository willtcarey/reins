/**
 * Git Diff Route (project-scoped)
 */

import type { RouterGroup, RouteContext } from "../router.js";
import { getGitDiff } from "../git.js";
import { getProject } from "../project-store.js";

export function registerDiffRoutes(router: RouterGroup) {
  router.get("/diff", async (ctx: RouteContext) => {
    const projectId = parseInt(ctx.params.id, 10);
    const projectDir = (ctx as any).projectDir as string;
    const project = getProject(projectId)!;
    const contextLines = Math.min(
      Math.max(parseInt(ctx.url.searchParams.get("context") ?? "3", 10) || 3, 0),
      500,
    );
    const diff = await getGitDiff(projectDir, contextLines, project.base_branch);
    return Response.json(diff);
  });
}

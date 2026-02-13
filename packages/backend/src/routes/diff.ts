/**
 * Git Diff Route (project-scoped)
 *
 * Returns a pre-parsed, syntax-highlighted diff structure.
 */

import type { RouterGroup, RouteContext } from "../router.js";
import { getHighlightedDiff } from "../git.js";
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
    const files = await getHighlightedDiff(projectDir, contextLines, project.base_branch);
    return Response.json({ files });
  });
}

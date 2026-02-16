/**
 * Git Diff Route (project-scoped)
 *
 * Returns a pre-parsed, syntax-highlighted diff structure.
 *
 * Always uses the working-tree-aware diff (`baseBranch...HEAD` + uncommitted
 * + untracked). When a task session is active, the task branch is already
 * checked out, so this naturally shows all task changes (committed AND
 * uncommitted) against the project's base branch.
 */

import type { RouterGroup, RouteContext } from "../router.js";
import { getHighlightedDiff, getCurrentBranch } from "../git.js";
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

    const [files, branch] = await Promise.all([
      getHighlightedDiff(projectDir, contextLines, project.base_branch),
      getCurrentBranch(projectDir),
    ]);
    return Response.json({ files, branch, baseBranch: project.base_branch });
  });
}

/**
 * Git Diff Routes (project-scoped)
 *
 * Two endpoints:
 *   GET /diff/files — lightweight file listing with +/− counts (for polling)
 *   GET /diff       — parsed diff hunks with raw text (highlighting done client-side)
 *
 * Both use the working-tree-aware diff (`baseBranch...HEAD` + uncommitted
 * + untracked). When a task session is active, the task branch is already
 * checked out, so this naturally shows all task changes (committed AND
 * uncommitted) against the project's base branch.
 */

import type { RouterGroup, RouteContext } from "../router.js";
import { getDiff, getChangedFiles, getCurrentBranch, resolveBaseBranchRef } from "../git.js";
import { getProject } from "../project-store.js";

export function registerDiffRoutes(router: RouterGroup) {
  /**
   * Lightweight file listing — cheap enough to poll every few seconds.
   * Returns file paths and +/− counts but no hunk/line data.
   */
  router.get("/diff/files", async (ctx: RouteContext) => {
    const projectId = parseInt(ctx.params.id, 10);
    const projectDir = (ctx as any).projectDir as string;
    const project = getProject(projectId)!;

    const baseBranchRef = await resolveBaseBranchRef(projectDir, project.base_branch);
    const [files, branch] = await Promise.all([
      getChangedFiles(projectDir, baseBranchRef),
      getCurrentBranch(projectDir),
    ]);
    return Response.json({ files, branch, baseBranch: project.base_branch });
  });

  /**
   * Full diff with parsed hunks — raw text, no syntax highlighting.
   * Highlighting is performed client-side using Shiki in a web worker.
   */
  router.get("/diff", async (ctx: RouteContext) => {
    const projectId = parseInt(ctx.params.id, 10);
    const projectDir = (ctx as any).projectDir as string;
    const project = getProject(projectId)!;
    const contextLines = Math.min(
      Math.max(parseInt(ctx.url.searchParams.get("context") ?? "3", 10) || 3, 0),
      500,
    );

    const baseBranchRef = await resolveBaseBranchRef(projectDir, project.base_branch);
    const [files, branch] = await Promise.all([
      getDiff(projectDir, contextLines, baseBranchRef),
      getCurrentBranch(projectDir),
    ]);
    return Response.json({ files, branch, baseBranch: project.base_branch });
  });
}

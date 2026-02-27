/**
 * Git Diff Routes (project-scoped)
 *
 * Two endpoints:
 *   GET /diff/files — lightweight file listing with +/− counts (for polling)
 *   GET /diff       — parsed diff hunks with raw text (highlighting done client-side)
 *
 * Both accept an optional `branch` query param. When provided, the diff is
 * computed against that branch instead of HEAD. If the branch is not currently
 * checked out, only committed changes are included (no uncommitted/untracked).
 * When omitted, the endpoints use HEAD and include uncommitted changes (the
 * previous default behavior).
 */

import type { RouterGroup } from "../router.js";
import type { ProjectRouteContext } from "./index.js";
import { getDiff, getChangedFiles, getCurrentBranch } from "../git.js";

export function registerDiffRoutes(router: RouterGroup<ProjectRouteContext>) {
  /**
   * Lightweight file listing — cheap enough to poll every few seconds.
   * Returns file paths and +/− counts but no hunk/line data.
   */
  router.get("/diff/files", async (ctx) => {
    const mode = ctx.url.searchParams.get("mode") === "uncommitted" ? "uncommitted" : "branch";
    const branch = ctx.url.searchParams.get("branch") ?? undefined;

    const [files, currentBranch] = await Promise.all([
      getChangedFiles(ctx.project.projectDir, ctx.project.baseBranch, mode, branch),
      getCurrentBranch(ctx.project.projectDir),
    ]);
    return Response.json({
      files,
      branch: branch ?? currentBranch,
      baseBranch: ctx.project.baseBranch,
    });
  });

  /**
   * Full diff with parsed hunks — raw text, no syntax highlighting.
   * Highlighting is performed client-side using Shiki in a web worker.
   */
  router.get("/diff", async (ctx) => {
    const contextLines = Math.min(
      Math.max(parseInt(ctx.url.searchParams.get("context") ?? "3", 10) || 3, 0),
      500,
    );
    const mode = ctx.url.searchParams.get("mode") === "uncommitted" ? "uncommitted" : "branch";
    const branch = ctx.url.searchParams.get("branch") ?? undefined;

    const [files, currentBranch] = await Promise.all([
      getDiff(ctx.project.projectDir, contextLines, ctx.project.baseBranch, mode, branch),
      getCurrentBranch(ctx.project.projectDir),
    ]);
    return Response.json({
      files,
      branch: branch ?? currentBranch,
      baseBranch: ctx.project.baseBranch,
    });
  });
}

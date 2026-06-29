/**
 * Git Diff Routes (project-scoped)
 *
 * Endpoints:
 *   GET /diff/files — lightweight file listing with +/− counts (for polling)
 *   GET /diff       — parsed diff hunks with raw text (highlighting done client-side)
 *   GET /diff/patch — raw unified patch text
 *
 * Both accept an optional `branch` query param. When provided, the diff is
 * computed against that branch instead of HEAD. If the branch is not currently
 * checked out, only committed changes are included (no uncommitted/untracked).
 * When omitted, the endpoints use HEAD and include uncommitted changes (the
 * previous default behavior).
 */

import type { RouterGroup } from "../router.js";
import type { ProjectRouteContext } from "./index.js";
import { getCurrentBranch } from "../git.js";

type DiffMode = "branch" | "uncommitted";

function parseDiffParams(url: URL): { contextLines: number; mode: DiffMode; branch?: string } {
  const parsedContext = parseInt(url.searchParams.get("context") ?? "3", 10);
  const contextLines = Math.min(
    Math.max(Number.isNaN(parsedContext) ? 3 : parsedContext, 0),
    500,
  );
  const mode = url.searchParams.get("mode") === "uncommitted" ? "uncommitted" : "branch";
  const branch = url.searchParams.get("branch") ?? undefined;

  return { contextLines, mode, branch };
}

export function registerDiffRoutes(router: RouterGroup<ProjectRouteContext>) {
  /**
   * Lightweight file listing — cheap enough to poll every few seconds.
   * Returns file paths and +/− counts but no hunk/line data.
   */
  router.get("/diff/files", async (ctx) => {
    const { mode, branch } = parseDiffParams(ctx.url);

    const [files, currentBranch] = await Promise.all([
      ctx.project.workspace.getChangedFiles(mode, branch),
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
    const { contextLines, mode, branch } = parseDiffParams(ctx.url);

    const [files, currentBranch] = await Promise.all([
      ctx.project.workspace.getDiff(contextLines, mode, branch),
      getCurrentBranch(ctx.project.projectDir),
    ]);
    return Response.json({
      files,
      branch: branch ?? currentBranch,
      baseBranch: ctx.project.baseBranch,
    });
  });

  /** Raw unified patch text for virtualized/streamed diff consumers. */
  router.get("/diff/patch", async (ctx) => {
    const { contextLines, mode, branch } = parseDiffParams(ctx.url);
    const patch = ctx.project.workspace.getDiffPatchStream(contextLines, mode, branch);

    // Bun accepts async iterables as response bodies; the cast bridges the DOM
    // Response type used by TypeScript in this package.
    // oxlint-disable-next-line typescript-eslint/consistent-type-assertions
    return new Response(patch as unknown as BodyInit, {
      headers: { "Content-Type": "text/x-diff; charset=utf-8" },
    });
  });
}

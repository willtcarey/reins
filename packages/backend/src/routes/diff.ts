/**
 * Git Diff Routes (session-scoped: the session's checkout)
 *
 * Endpoints:
 *   GET /diff/files — lightweight file listing with +/− counts (for polling)
 *   GET /diff/patch — raw unified patch text
 *
 * Both accept an optional `branch` query param. When provided, the diff is
 * computed against that branch instead of HEAD. If the branch is not currently
 * checked out, only committed changes are included (no uncommitted/untracked).
 * Without a branch, `base` (a commit: a task without a branch of its own, since
 * it started) diffs the working tree against it. With neither, the endpoints use
 * HEAD and include uncommitted changes.
 */

import type { RouterGroup } from "../router.js";
import type { SessionRouteContext } from "./index.js";
import type { DiffFileSummary } from "../models/diff-parser.js";
import type { DiffMode, DiffTarget } from "../models/workspace.js";

export interface DiffQuery { mode?: DiffMode; branch?: string; base?: string }
export interface DiffPatchQuery extends DiffQuery { context?: number }
export interface DiffFileResponse {
  files: DiffFileSummary[];
  branch: string | null;
  baseBranch: string | null;
}

function parseDiffParams(url: URL): { contextLines: number; mode: DiffMode; target: DiffTarget } {
  const parsedContext = parseInt(url.searchParams.get("context") ?? "3", 10);
  const contextLines = Math.min(
    Math.max(Number.isNaN(parsedContext) ? 3 : parsedContext, 0),
    500,
  );
  const mode = url.searchParams.get("mode") === "uncommitted" ? "uncommitted" : "branch";
  const branch = url.searchParams.get("branch") || undefined;
  const base = url.searchParams.get("base") || undefined;

  return { contextLines, mode, target: { ...(branch ? { branch } : {}), ...(base ? { base } : {}) } };
}

export function registerDiffRoutes(router: RouterGroup<SessionRouteContext>) {
  /**
   * Lightweight file listing — cheap enough to poll every few seconds.
   * Returns file paths and +/− counts but no hunk/line data.
   */
  router.get("/diff/files", async (ctx) => {
    const { mode, target } = parseDiffParams(ctx.url);

    const [files, currentBranch] = await Promise.all([
      ctx.session.workspace.getChangedFiles(mode, target),
      ctx.session.workspace.currentBranch(),
    ]);
    return Response.json({
      files,
      branch: target.branch ?? currentBranch,
      baseBranch: ctx.session.baseBranch,
    } satisfies DiffFileResponse);
  });

  /** Raw unified patch text for patch-backed diff consumers. */
  router.get("/diff/patch", async (ctx) => {
    const { contextLines, mode, target } = parseDiffParams(ctx.url);
    const patch = ctx.session.workspace.getDiffPatchStream(contextLines, mode, target);

    // Bun accepts async iterables as response bodies; the cast bridges the DOM
    // Response type used by TypeScript in this package.
    // oxlint-disable-next-line typescript-eslint/consistent-type-assertions
    return new Response(patch as unknown as BodyInit, {
      headers: { "Content-Type": "text/x-diff; charset=utf-8" },
    });
  });
}

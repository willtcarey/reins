/**
 * Git Remote Sync Routes (project-scoped)
 *
 * Endpoints for commit spread queries, push, and rebase operations.
 *
 *   GET  /git/spread  — commit counts (ahead/behind base & remote)
 *   POST /git/push    — push a branch to origin
 *   POST /git/rebase  — rebase a branch onto the base branch
 */

import type { RouterGroup, RouteContext } from "../router.js";
import { badRequest } from "../errors.js";
import {
  getSpread,
  pushBranch,
  rebaseBranch,
} from "../git.js";

export function registerGitRoutes(router: RouterGroup) {
  /**
   * GET /git/spread?branch=feature/foo&fetch=false
   *
   * Returns the four commit counts for a branch relative to the base branch
   * and its remote tracking branch. When fetch=true, runs fetchAll +
   * pullBaseBranch first to refresh remote refs.
   */
  router.get("/git/spread", async (ctx: RouteContext) => {
    const branch = ctx.url.searchParams.get("branch");
    if (!branch) badRequest("branch query parameter is required");

    const shouldFetch = ctx.url.searchParams.get("fetch") === "true";

    if (shouldFetch) {
      await ctx.project!.sync();
    }

    const spread = await getSpread(ctx.project!.projectDir, branch!, ctx.project!.baseBranch);

    return Response.json({ branch, ...spread });
  });

  /**
   * POST /git/push
   *
   * Pushes a branch to origin.
   * Request body: { "branch": "feature/foo" }
   */
  router.post("/git/push", async (ctx: RouteContext) => {
    const body = (await ctx.req.json()) as { branch?: string };

    if (!body.branch?.trim()) badRequest("branch is required");

    try {
      await pushBranch(ctx.project!.projectDir, body.branch!.trim());
      return Response.json({ ok: true });
    } catch (err: any) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  });

  /**
   * POST /git/rebase
   *
   * Rebases a branch onto the project's base branch.
   * Request body: { "branch": "feature/foo" }
   */
  router.post("/git/rebase", async (ctx: RouteContext) => {
    const body = (await ctx.req.json()) as { branch?: string };

    if (!body.branch?.trim()) badRequest("branch is required");

    try {
      await rebaseBranch(ctx.project!.projectDir, body.branch!.trim(), ctx.project!.baseBranch);
      return Response.json({ ok: true });
    } catch (err: any) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  });
}

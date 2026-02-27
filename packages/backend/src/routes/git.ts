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
import { getProject } from "../project-store.js";
import {
  getSpread,
  pushBranch,
  rebaseBranch,
} from "../git.js";
import { createBroadcast } from "../models/broadcast.js";
import { ProjectModel } from "../models/projects.js";

export function registerGitRoutes(router: RouterGroup) {
  /**
   * GET /git/spread?branch=feature/foo&fetch=false
   *
   * Returns the four commit counts for a branch relative to the base branch
   * and its remote tracking branch. When fetch=true, runs fetchAll +
   * pullBaseBranch first to refresh remote refs.
   */
  router.get("/git/spread", async (ctx: RouteContext) => {
    const projectId = parseInt(ctx.params.id, 10);
    const projectDir = (ctx as any).projectDir as string;
    const project = getProject(projectId)!;

    const branch = ctx.url.searchParams.get("branch");
    if (!branch) badRequest("branch query parameter is required");

    const shouldFetch = ctx.url.searchParams.get("fetch") === "true";

    if (shouldFetch) {
      const projectModel = new ProjectModel(projectId, projectDir, project.base_branch, createBroadcast(ctx.state.clients));
      await projectModel.sync();
    }

    const spread = await getSpread(projectDir, branch!, project.base_branch);

    return Response.json({ branch, ...spread });
  });

  /**
   * POST /git/push
   *
   * Pushes a branch to origin.
   * Request body: { "branch": "feature/foo" }
   */
  router.post("/git/push", async (ctx: RouteContext) => {
    const projectDir = (ctx as any).projectDir as string;
    const body = (await ctx.req.json()) as { branch?: string };

    if (!body.branch?.trim()) badRequest("branch is required");

    try {
      await pushBranch(projectDir, body.branch!.trim());
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
    const projectId = parseInt(ctx.params.id, 10);
    const projectDir = (ctx as any).projectDir as string;
    const project = getProject(projectId)!;
    const body = (await ctx.req.json()) as { branch?: string };

    if (!body.branch?.trim()) badRequest("branch is required");

    try {
      await rebaseBranch(projectDir, body.branch!.trim(), project.base_branch);
      return Response.json({ ok: true });
    } catch (err: any) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  });
}

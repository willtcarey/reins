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
  fetchAll,
  fastForwardBaseBranch,
  getSpread,
  getMergedBranches,
  getCurrentBranch,
  checkoutBranch,
  deleteBranch,
  pushBranch,
  rebaseBranch,
} from "../git.js";
import { listOpenTasks, markTasksMerged } from "../task-store.js";

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
      await fetchAll(projectDir);
      await fastForwardBaseBranch(projectDir, project.base_branch);
      // Reconcile merged task statuses
      await reconcileMergedTasks(projectId, projectDir, project.base_branch);
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

/**
 * Check which open tasks have been merged into the base branch and update
 * their status. Called after fetch + fast-forward so local refs are current.
 */
async function reconcileMergedTasks(
  projectId: number,
  projectDir: string,
  baseBranch: string,
): Promise<void> {
  const openTasks = listOpenTasks(projectId);
  if (openTasks.length === 0) return;

  const mergedBranches = new Set(await getMergedBranches(projectDir, baseBranch));
  const mergedTasks = openTasks.filter((t) => mergedBranches.has(t.branch_name));
  if (mergedTasks.length === 0) return;

  markTasksMerged(mergedTasks.map((t) => t.id));

  // Clean up local branches — they're fully in the base branch now
  const currentBranch = await getCurrentBranch(projectDir);
  for (const task of mergedTasks) {
    try {
      if (currentBranch === task.branch_name) {
        await checkoutBranch(projectDir, baseBranch);
      }
      await deleteBranch(projectDir, task.branch_name);
    } catch (err: any) {
      console.warn(`  Could not delete merged branch ${task.branch_name}: ${err.message}`);
    }
  }
}

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
  branchExists,
  remoteBranchExists,
  getBranchTip,
  pushBranch,
  rebaseBranch,
} from "../git.js";
import { listOpenTasks, markTasksClosed } from "../task-store.js";
import { createBroadcast } from "../models/broadcast.js";

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
      // Reconcile closed task statuses
      await reconcileClosedTasks(projectId, projectDir, project.base_branch, createBroadcast(ctx.state.clients));
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
 * Check which open tasks should be closed and update their status.
 * Called after fetch + fast-forward so local refs are current.
 *
 * A task is closed when:
 *  1. Its branch is reachable from the base branch (i.e. merged but not yet
 *     deleted), OR
 *  2. Its branch no longer exists locally or on the remote — this covers
 *     fast-forward merges where the branch was deleted before reconciliation
 *     ran, so `git branch --merged` can no longer see it.
 */
async function reconcileClosedTasks(
  projectId: number,
  projectDir: string,
  baseBranch: string,
  broadcast: import("../models/broadcast.js").Broadcast,
): Promise<void> {
  const openTasks = listOpenTasks(projectId);
  if (openTasks.length === 0) return;

  // 1. Branches that are still around and fully merged
  const mergedBranches = new Set(await getMergedBranches(projectDir, baseBranch));

  const toClose: typeof openTasks = [];
  const toCleanUpBranch: typeof openTasks = [];

  for (const task of openTasks) {
    if (mergedBranches.has(task.branch_name)) {
      // The branch is reachable from the base branch. Only treat it as merged
      // if it actually diverged from its creation point — a branch created
      // from the base with zero commits is technically "merged" per git, but
      // the task hasn't started yet.
      //
      // Compare the branch tip to the stored base_commit SHA: if they're equal
      // the branch never received any commits and should be left open. If
      // base_commit is null (pre-migration task), fall through to close —
      // there's no way to distinguish, and closing is the safer default.
      if (task.base_commit) {
        const tip = await getBranchTip(projectDir, task.branch_name);
        if (tip === task.base_commit) {
          // Branch never diverged — skip it
          continue;
        }
      }
      toClose.push(task);
      toCleanUpBranch.push(task);
    } else {
      // 2. Branch gone everywhere — treat as closed
      const local = await branchExists(projectDir, task.branch_name);
      const remote = await remoteBranchExists(projectDir, task.branch_name);
      if (!local && !remote) {
        toClose.push(task);
      }
    }
  }

  if (toClose.length === 0) return;

  markTasksClosed(toClose.map((t) => t.id));
  broadcast({ type: "task_updated", projectId });

  // Clean up local branches for tasks that were detected via --merged
  const currentBranch = await getCurrentBranch(projectDir);
  for (const task of toCleanUpBranch) {
    try {
      if (currentBranch === task.branch_name) {
        await checkoutBranch(projectDir, baseBranch);
      }
      await deleteBranch(projectDir, task.branch_name);
    } catch (err: any) {
      console.warn(`  Could not delete branch ${task.branch_name}: ${err.message}`);
    }
  }
}

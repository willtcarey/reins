/**
 * File Content Route (project-scoped)
 *
 * Returns the raw content of a file. When a `ref` query parameter is
 * provided (e.g. a branch name), the content is read from that git ref
 * via `git show ref:path` — this works even when the branch is not
 * checked out. Without `ref`, the file is read from the working tree.
 * Used by the frontend to render markdown previews of changed files.
 */

import type { RouterGroup, RouteContext } from "../router.js";
import { badRequest, notFound } from "../errors.js";
import { getProject } from "../project-store.js";
import { ProjectModel, PathTraversalError, FileNotFoundError } from "../models/projects.js";
import { createBroadcast } from "../models/broadcast.js";

export function registerFileRoutes(router: RouterGroup) {
  router.get("/file", async (ctx: RouteContext) => {
    const projectId = parseInt(ctx.params.id, 10);
    const projectDir = (ctx as any).projectDir as string;
    const project = getProject(projectId)!;
    const filePath = ctx.url.searchParams.get("path");
    const ref = ctx.url.searchParams.get("ref");

    if (!filePath) badRequest("Missing ?path= parameter");

    try {
      const projectModel = new ProjectModel(projectId, projectDir, project.base_branch, ctx.state.sessions, createBroadcast(ctx.state.clients));
      const content = await projectModel.readFile(filePath!, ref);
      return new Response(content, {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    } catch (err: any) {
      if (err instanceof PathTraversalError) badRequest(err.message);
      if (err instanceof FileNotFoundError) notFound(err.message);
      throw err;
    }
  });
}

/**
 * Project CRUD Routes
 */

import { existsSync } from "fs";
import type { RouterGroup, RouteContext } from "../router.js";
import { API } from "../api-paths.js";
import { badRequest, notFound, conflict } from "../errors.js";
import {
  listProjects, getProject, createProject,
  updateProject, deleteProject,
} from "../project-store.js";
import { detectDefaultBranch } from "../git.js";

export function registerProjectRoutes(router: RouterGroup) {
  // List all projects
  router.get(API.projects, async () => {
    return Response.json(listProjects());
  });

  // Create a project
  router.post(API.projects, async (ctx: RouteContext) => {
    const body = await ctx.req.json() as { name?: string; path?: string; base_branch?: string };
    if (!body.name || !body.path) {
      badRequest("name and path are required");
    }
    if (!existsSync(body.path!)) {
      badRequest(`Directory does not exist: ${body.path}`);
    }
    const baseBranch = body.base_branch || await detectDefaultBranch(body.path!);

    try {
      const project = createProject(body.name!, body.path!, baseBranch);
      return Response.json(project, { status: 201 });
    } catch (err: any) {
      if (err.message?.includes("UNIQUE constraint")) {
        conflict("A project with that path already exists");
      }
      throw err;
    }
  });

  // Update a project
  router.patch(API.project, async (ctx: RouteContext) => {
    const id = parseInt(ctx.params.id, 10);
    const body = await ctx.req.json() as { name?: string; path?: string; base_branch?: string };
    const updated = updateProject(id, body);
    if (!updated) notFound("Project not found");
    return Response.json(updated);
  });

  // Delete a project
  router.delete(API.project, async (ctx: RouteContext) => {
    const id = parseInt(ctx.params.id, 10);
    const deleted = deleteProject(id);
    if (!deleted) notFound("Project not found");
    return Response.json({ ok: true });
  });
}

/**
 * Project CRUD Routes
 */

import { existsSync } from "fs";
import { Type } from "@sinclair/typebox";
import type { RouterGroup } from "../router.js";
import { API } from "../api-paths.js";
import { badRequest, notFound, conflict } from "../errors.js";
import {
  listProjects,
  updateProject, deleteProject,
} from "../project-store.js";
import { createProject, DuplicateProjectError } from "../models/projects.js";
import { parseBody, parseIntParam } from "./validate.js";

const CreateProjectBody = Type.Object({
  name: Type.String({ minLength: 1 }),
  path: Type.String({ minLength: 1 }),
  base_branch: Type.Optional(Type.String()),
});

const UpdateProjectBody = Type.Object({
  name: Type.Optional(Type.String()),
  path: Type.Optional(Type.String()),
  base_branch: Type.Optional(Type.String()),
});

export function registerProjectRoutes(router: RouterGroup) {
  // List all projects
  router.get(API.projects, async () => {
    return Response.json(listProjects());
  });

  // Create a project
  router.post(API.projects, async (ctx) => {
    const body = await parseBody(CreateProjectBody, ctx.req);
    if (!existsSync(body.path)) {
      badRequest(`Directory does not exist: ${body.path}`);
    }

    try {
      const project = await createProject({
        name: body.name,
        path: body.path,
        base_branch: body.base_branch,
      });
      return Response.json(project, { status: 201 });
    } catch (err: unknown) {
      if (err instanceof DuplicateProjectError) conflict(err.message);
      throw err;
    }
  });

  // Update a project
  router.patch(API.project, async (ctx) => {
    const id = parseIntParam(ctx.params, "id");
    const body = await parseBody(UpdateProjectBody, ctx.req);

    if (body.name !== undefined && !body.name.trim()) {
      badRequest("name cannot be empty");
    }
    if (body.path !== undefined) {
      if (!body.path.trim()) badRequest("path cannot be empty");
      if (!existsSync(body.path)) badRequest(`Directory does not exist: ${body.path}`);
    }

    const updates: { name?: string; path?: string; base_branch?: string } = {};
    if (body.name !== undefined) updates.name = body.name.trim();
    if (body.path !== undefined) updates.path = body.path.trim();
    if (body.base_branch !== undefined) updates.base_branch = body.base_branch.trim() || "main";

    const updated = updateProject(id, updates);
    if (!updated) notFound("Project not found");
    return Response.json(updated);
  });

  // Delete a project
  router.delete(API.project, async (ctx) => {
    const id = parseIntParam(ctx.params, "id");
    const deleted = deleteProject(id);
    if (!deleted) notFound("Project not found");
    return Response.json({ ok: true });
  });
}

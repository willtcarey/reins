/**
 * Project CRUD Routes
 */

import { Type, type Static } from "@sinclair/typebox";
import type { RouterGroup } from "../router.js";
import { API } from "../api-paths.js";
import { badRequest, notFound, conflict } from "../errors.js";
import { listProjects, deleteProject } from "../project-store.js";
import { CheckoutNotFoundError, createProject, DuplicateProjectError, editProject, NodeNotFoundError } from "../models/projects.js";
import { closeDeletedSessions, sessionsOnNodes } from "../sessions/session-ownership.js";
import { parseBody, parseIntParam } from "./validate.js";

const CreateProjectBody = Type.Object({
  name: Type.String({ minLength: 1 }),
  /** The checkout's path on the node. */
  path: Type.String({ minLength: 1 }),
  /** The node holding the checkout: the project's first source. */
  nodeId: Type.String({ minLength: 1 }),
  base_branch: Type.Optional(Type.String()),
});

const UpdateProjectBody = Type.Object({
  name: Type.Optional(Type.String()),
  path: Type.Optional(Type.String()),
  base_branch: Type.Optional(Type.String()),
});

export type ProjectInput = Static<typeof CreateProjectBody>;
export type ProjectUpdate = Static<typeof UpdateProjectBody>;

export function registerProjectRoutes(router: RouterGroup) {
  // List all projects
  router.get(API.projects, async () => {
    return Response.json(listProjects());
  });

  // Create a project
  router.post(API.projects, async (ctx) => {
    const body = await parseBody(CreateProjectBody, ctx.req);

    try {
      const project = await createProject({
        name: body.name,
        path: body.path,
        nodeId: body.nodeId,
        base_branch: body.base_branch,
      }, ctx.state.nodes);
      return Response.json(project, { status: 201 });
    } catch (err: unknown) {
      if (err instanceof DuplicateProjectError) conflict(err.message);
      if (err instanceof NodeNotFoundError || err instanceof CheckoutNotFoundError) badRequest(err.message);
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
    if (body.path !== undefined && !body.path.trim()) {
      badRequest("path cannot be empty");
    }

    const updates: { name?: string; path?: string; base_branch?: string } = {};
    if (body.name !== undefined) updates.name = body.name.trim();
    if (body.path !== undefined) updates.path = body.path.trim();
    if (body.base_branch !== undefined) updates.base_branch = body.base_branch.trim() || "main";

    try {
      const updated = await editProject(id, updates, ctx.state.nodes);
      if (!updated) notFound("Project not found");
      return Response.json(updated);
    } catch (err: unknown) {
      if (err instanceof CheckoutNotFoundError) badRequest(err.message);
      throw err;
    }
  });

  // Delete a project
  router.delete(API.project, async (ctx) => {
    const id = parseIntParam(ctx.params, "id");
    const sessions = sessionsOnNodes({ projectId: id });
    const deleted = deleteProject(id);
    if (!deleted) notFound("Project not found");
    closeDeletedSessions(ctx.state.nodes, sessions);
    return Response.json({ ok: true });
  });
}

/**
 * Project CRUD Routes
 */

import { Type, type Static } from "@sinclair/typebox";
import type { RouterGroup } from "../router.js";
import { API } from "../api-paths.js";
import { badRequest, notFound } from "../errors.js";
import { listProjects, type Project } from "../project-store.js";
import { ProjectNotFoundError } from "../models/projects.js";
import { CheckoutNotFoundError } from "../models/sources.js";
import { NodeNotFoundError } from "../models/nodes.js";
import { getSource } from "../node-store.js";
import { parseBody, parseIntParam } from "./validate.js";

const CreateProjectBody = Type.Object({
  name: Type.String({ minLength: 1 }),
  /** The project's default source: the checkout's path on node `nodeId`. */
  path: Type.String({ minLength: 1 }),
  nodeId: Type.String({ minLength: 1 }),
  base_branch: Type.Optional(Type.String()),
});

const UpdateProjectBody = Type.Object({
  name: Type.Optional(Type.String()),
  base_branch: Type.Optional(Type.String()),
  /** A new default source (its sessions stay where they are). */
  defaultSource: Type.Optional(Type.Object({ nodeId: Type.String({ minLength: 1 }), path: Type.String({ minLength: 1, pattern: "\\S" }) })),
});

/** A project as the API answers it: its row, with its default source's node and path. */
export type ProjectView = Project & { defaultSource: { nodeId: string; path: string } | null };

function projectView(project: Project): ProjectView {
  const source = project.default_source_id == null ? null : getSource(project.default_source_id);
  return { ...project, defaultSource: source && { nodeId: source.node_id, path: source.path } };
}

export type ProjectInput = Static<typeof CreateProjectBody>;
export type ProjectUpdate = Static<typeof UpdateProjectBody>;

export function registerProjectRoutes(router: RouterGroup) {
  // List all projects
  router.get(API.projects, async () => {
    return Response.json(listProjects().map(projectView));
  });

  // Create a project
  router.post(API.projects, async (ctx) => {
    const body = await parseBody(CreateProjectBody, ctx.req);

    try {
      const project = await ctx.models.projects.create({
        name: body.name,
        path: body.path,
        nodeId: body.nodeId,
        base_branch: body.base_branch,
      });
      return Response.json(projectView(project), { status: 201 });
    } catch (err: unknown) {
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

    try {
      const updated = await ctx.models.projects.update(id, {
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.base_branch === undefined ? {} : { baseBranch: body.base_branch }),
        ...(body.defaultSource ? { defaultSource: body.defaultSource } : {}),
      });
      return Response.json(projectView(updated));
    } catch (err) {
      if (err instanceof ProjectNotFoundError) notFound("Project not found");
      if (err instanceof NodeNotFoundError || err instanceof CheckoutNotFoundError) badRequest(err.message);
      throw err;
    }
  });

  // Delete a project
  router.delete(API.project, async (ctx) => {
    const id = parseIntParam(ctx.params, "id");
    try {
      await ctx.models.projects.delete(id);
    } catch (err) {
      if (err instanceof ProjectNotFoundError) notFound("Project not found");
      throw err;
    }
    return Response.json({ ok: true });
  });
}

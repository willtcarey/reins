/**
 * Project API function definitions and schema.
 */

import { Type } from "@sinclair/typebox";
import { getProject, listProjects } from "../project-store.js";
import { type ApiFunctionDef, defineFunction } from "./define-function.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const ProjectSchema = Type.Object({
  id: Type.Number(),
  name: Type.String(),
  base_branch: Type.String(),
  default_source_id: Type.Union([Type.Number(), Type.Null()], { description: "Its default source: where it was created, where a new session of it works unless told otherwise." }),
  created_at: Type.String(),
  last_opened_at: Type.String(),
});

// ---------------------------------------------------------------------------
// Function definitions
// ---------------------------------------------------------------------------

export const PROJECT_FUNCTIONS: ApiFunctionDef[] = [
  defineFunction({
    name: "projects.list",
    description: "List all projects.",
    parameters: Type.Object({}),
    returns: Type.Array(ProjectSchema),
    tags: ["projects", "list", "query", "read"],
    execute: () => listProjects(),
  }),
  defineFunction({
    name: "projects.get",
    description: "Get a single project by ID. Throws if not found.",
    parameters: Type.Object({ projectId: Type.Number() }),
    returns: ProjectSchema,
    tags: ["projects", "get", "read", "lookup"],
    execute: (params, _ctx) => {
      const project = getProject(params.projectId);
      if (!project) throw new Error(`Project ${params.projectId} not found`);
      return project;
    },
  }),
  defineFunction({
    name: "projects.create",
    description:
      "Create a new project whose default source is `path` on node `nodeId` (default: the node this session runs on), a directory there. " +
      "Detects the default branch (main, master or develop) there if not provided.",
    parameters: Type.Object({
      name: Type.String(),
      path: Type.String(),
      base_branch: Type.Optional(Type.String()),
      nodeId: Type.Optional(Type.String()),
    }),
    returns: ProjectSchema,
    async: true,
    tags: ["projects", "create", "write", "mutation"],
    execute: ({ nodeId, ...params }, ctx) => {
      return ctx.models.projects.create({ ...params, nodeId: nodeId ?? ctx.session.source.record.node_id });
    },
  }),
  defineFunction({
    name: "projects.current",
    description: "Get the current project (the one this session belongs to), or null for a session of no project. No ID needed.",
    parameters: Type.Object({}),
    returns: Type.Union([ProjectSchema, Type.Null()]),
    tags: ["projects", "current", "read", "self", "context"],
    execute: (_params, ctx) => {
      const { projectId } = ctx.session;
      if (projectId === null) return null;
      const project = getProject(projectId);
      if (!project) throw new Error(`Project ${projectId} not found`);
      return project;
    },
  }),
];

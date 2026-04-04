/**
 * Project API function definitions and schema.
 */

import { Type } from "@sinclair/typebox";
import { getProject, listProjects } from "../project-store.js";
import { createProject } from "../models/projects.js";
import { type ApiFunctionDef, defineFunction } from "./define-function.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const ProjectSchema = Type.Object({
  id: Type.Number(),
  name: Type.String(),
  path: Type.String(),
  base_branch: Type.String(),
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
      "Create a new project. Detects the default branch automatically if not provided. " +
      "Throws if a project with that path already exists.",
    parameters: Type.Object({
      name: Type.String(),
      path: Type.String(),
      base_branch: Type.Optional(Type.String()),
    }),
    returns: ProjectSchema,
    async: true,
    tags: ["projects", "create", "write", "mutation"],
    execute: (params) => createProject(params),
  }),
  defineFunction({
    name: "projects.current",
    description: "Get the current project (the one this session belongs to). No ID needed.",
    parameters: Type.Object({}),
    returns: ProjectSchema,
    tags: ["projects", "current", "read", "self", "context"],
    execute: (_params, ctx) => {
      const project = getProject(ctx.projectId);
      if (!project) throw new Error(`Project ${ctx.projectId} not found`);
      return project;
    },
  }),
];

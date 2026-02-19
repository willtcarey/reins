/**
 * Route Composition
 *
 * Builds the full router by registering all resource routes.
 * This file gives a birds-eye view of the entire API surface.
 */

import { existsSync } from "fs";
import { createRouter } from "../router.js";
import type { RouteContext, Middleware } from "../router.js";
import { API } from "../api-paths.js";
import { notFound, badRequest } from "../errors.js";
import { getProject } from "../project-store.js";
import { registerHealthRoutes } from "./health.js";
import { registerProjectRoutes } from "./projects.js";
import { registerSessionRoutes } from "./sessions.js";
import { registerDiffRoutes } from "./diff.js";
import { registerFileRoutes } from "./file.js";
import { registerTaskRoutes } from "./tasks.js";
import { registerGitRoutes } from "./git.js";

// ---- Project middleware ----------------------------------------------------

/**
 * Resolves the :id param to a project, validates the directory exists,
 * and attaches projectDir to the context for downstream handlers.
 */
const projectMiddleware: Middleware = (ctx: RouteContext) => {
  const projectId = parseInt(ctx.params.id, 10);
  const project = getProject(projectId);
  if (!project) notFound("Project not found");
  if (!existsSync(project!.path)) {
    badRequest(`Directory does not exist: ${project!.path}`);
  }
  (ctx as any).projectDir = project!.path;
};

// ---- Build router ----------------------------------------------------------

export function buildRouter() {
  const router = createRouter();

  registerHealthRoutes(router);
  registerProjectRoutes(router);

  router.group(API.project, projectMiddleware, (r) => {
    registerSessionRoutes(r);
    registerDiffRoutes(r);
    registerFileRoutes(r);
    registerTaskRoutes(r);
    registerGitRoutes(r);
  });

  return router;
}

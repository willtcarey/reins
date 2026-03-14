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
import { ProjectModel } from "../models/projects.js";
import { createBroadcast } from "../models/broadcast.js";
import { registerHealthRoutes } from "./health.js";
import { registerProjectRoutes } from "./projects.js";
import { registerSessionRoutes } from "./sessions.js";
import { registerProjectSessionRoutes } from "./project-sessions.js";
import { registerTaskSessionRoutes } from "./task-sessions.js";
import { registerDiffRoutes } from "./diff.js";
import { registerFileRoutes } from "./file.js";
import { registerTaskRoutes } from "./tasks.js";
import { registerGitRoutes } from "./git.js";
import { registerPaletteRoutes } from "./palette.js";
import { registerUploadRoutes } from "./upload.js";

/** Context available to handlers inside the project group (after project middleware). */
export type ProjectRouteContext = RouteContext & { project: ProjectModel };

// ---- Project middleware ----------------------------------------------------

/**
 * Resolves the :id param to a project, validates the directory exists,
 * and attaches a ProjectModel to the context for downstream handlers.
 */
const projectMiddleware: Middleware<{ project: ProjectModel }> = (ctx) => {
  const projectId = parseInt(ctx.params.id, 10);
  const project = getProject(projectId);
  if (!project) notFound("Project not found");
  if (!existsSync(project!.path)) {
    badRequest(`Directory does not exist: ${project!.path}`);
  }
  Object.assign(ctx, {
    project: new ProjectModel(
      project!.id, project!.path, project!.base_branch,
      ctx.state.sessions, createBroadcast(ctx.state.clients),
    ),
  });
};

// ---- Build router ----------------------------------------------------------

export function buildRouter() {
  const router = createRouter();

  registerHealthRoutes(router);
  registerProjectRoutes(router);
  registerPaletteRoutes(router);
  router.group(API.sessions, (r) => {
    registerSessionRoutes(r);
  });

  router.group(API.tasks, (r) => {
    registerTaskSessionRoutes(r);
  });

  router.group(API.project, projectMiddleware, (r) => {
    registerProjectSessionRoutes(r);
    registerDiffRoutes(r);
    registerFileRoutes(r);
    registerTaskRoutes(r);
    registerGitRoutes(r);
    registerUploadRoutes(r);
  });

  return router;
}

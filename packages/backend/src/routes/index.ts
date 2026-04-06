import { existsSync } from "fs";
import { createRouter } from "../router.js";
import type { RouteContext, Middleware } from "../router.js";
import { API } from "../api-paths.js";
import { notFound, badRequest } from "../errors.js";
import { getProject } from "../project-store.js";
import { parseIntParam } from "./validate.js";
import { ProjectModel } from "../models/projects.js";
import { createBroadcast } from "../models/broadcast.js";
import { registerHealthRoutes } from "./health.js";
import { registerProjectRoutes } from "./projects.js";
import { registerSessionRoutes } from "./sessions.js";
import { registerProjectSessionRoutes } from "./project-sessions.js";
import { registerTaskSessionRoutes } from "./task-sessions.js";
import { registerDiffRoutes } from "./diff.js";
import { registerFileRoutes } from "./files.js";
import { registerTaskRoutes } from "./tasks.js";
import { registerGitRoutes } from "./git.js";
import { registerPaletteRoutes } from "./palette.js";
import { registerUploadRoutes } from "./upload.js";
import { registerSettingsRoutes } from "./settings.js";
import { registerModelsRoutes } from "./models.js";
import { registerOAuthRoutes } from "./oauth.js";
import { registerAuthRoutes } from "./auth.js";

export type ProjectRouteContext = RouteContext & { project: ProjectModel };

const projectMiddleware: Middleware<{ project: ProjectModel }> = (ctx) => {
  const projectId = parseIntParam(ctx.params, "id");
  const project = getProject(projectId);
  if (!project) notFound("Project not found");
  if (!existsSync(project.path)) {
    badRequest(`Directory does not exist: ${project.path}`);
  }
  Object.assign(ctx, {
    project: new ProjectModel(
      project.id, ctx.state.sessions, createBroadcast(ctx.state.clients),
    ),
  });
};

export function buildRouter() {
  const router = createRouter();

  registerHealthRoutes(router);
  registerProjectRoutes(router);
  registerPaletteRoutes(router);
  registerSettingsRoutes(router);
  registerModelsRoutes(router);
  registerAuthRoutes(router);
  registerOAuthRoutes(router);
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

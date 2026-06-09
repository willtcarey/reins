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
import { registerSkillRoutes } from "./skills.js";
import { registerSettingsRoutes } from "./settings.js";
import { registerModelsRoutes } from "./models.js";
import { registerOAuthRoutes } from "./oauth.js";
import { registerAuthRoutes } from "./auth.js";
import { registerAttachmentRoutes } from "./attachments.js";
import { listActiveSessions } from "../session-store.js";

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

  // List all sessions with non-null activity_state — for initial page-load
  // reconciliation without needing to expand every project first.
  router.get("/api/activity", () => {
    return Response.json(listActiveSessions());
  });
  registerPaletteRoutes(router);
  registerSettingsRoutes(router);
  registerModelsRoutes(router);
  router.group(API.auth, (r) => {
    registerAuthRoutes(r);
  });
  router.group(API.oauth, (r) => {
    registerOAuthRoutes(r);
  });
  router.group(API.sessions, (r) => {
    registerSessionRoutes(r);
    registerAttachmentRoutes(r);
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
    registerSkillRoutes(r);
  });

  return router;
}

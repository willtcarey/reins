import { createRouter } from "../router.js";
import type { RouteContext, Middleware } from "../router.js";
import { API } from "../api-paths.js";
import { notFound } from "../errors.js";
import { parseIntParam } from "./validate.js";
import { ProjectNotFoundError, type ProjectModel } from "../models/projects.js";
import { SourceNotFoundError } from "../models/sources.js";
import { SessionNotFoundError } from "../models/sessions.js";
import type { SessionModel } from "../models/session.js";
import { registerHealthRoutes } from "./health.js";
import { registerProjectRoutes } from "./projects.js";
import { registerNodeRoutes } from "./nodes.js";
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
import { registerExtensionRoutes } from "./extensions.js";
import { registerAuthRoutes } from "./auth.js";
import { registerAttachmentRoutes } from "./attachments.js";
import { registerClientTelemetryRoutes } from "./client-telemetry.js";
import { registerCodeReviewRoutes } from "./code-reviews.js";
import { registerSocketRoutes } from "./sockets.js";

export type ProjectRouteContext = RouteContext & { project: ProjectModel };

/** A session's views (files, diffs, git, uploads): `ctx.session`, whose `source` and `workspace` are its own
 * checkout, so a session moved to another node shows that node's. */
export type SessionRouteContext = RouteContext & { session: SessionModel };

const projectMiddleware: Middleware<{ project: ProjectModel }> = (ctx: RouteContext) => {
  try {
    Object.assign(ctx, { project: ctx.models.project(parseIntParam(ctx.params, "id")) });
  } catch (err) {
    if (err instanceof ProjectNotFoundError) notFound("Project not found");
    if (err instanceof SourceNotFoundError) notFound(err.message);
    throw err;
  }
};

const sessionMiddleware: Middleware<{ session: SessionModel }> = (ctx: RouteContext) => {
  try {
    Object.assign(ctx, { session: ctx.models.sessions.get(ctx.params.sessionId!) });
  } catch (err) {
    if (err instanceof SessionNotFoundError) notFound(err.message);
    throw err;
  }
};

export function buildRouter() {
  const router = createRouter();

  registerSocketRoutes(router);
  registerHealthRoutes(router);
  if (process.env.REINS_DEV === "1") registerClientTelemetryRoutes(router);
  registerProjectRoutes(router);
  registerNodeRoutes(router);
  registerSkillRoutes(router);
  registerPaletteRoutes(router);
  registerSettingsRoutes(router);
  registerModelsRoutes(router);
  registerExtensionRoutes(router);
  router.group(API.auth, (r) => {
    registerAuthRoutes(r);
  });
  router.group(API.oauth, (r) => {
    registerOAuthRoutes(r);
  });
  router.group(API.sessions, (r) => {
    registerSessionRoutes(r);
    registerAttachmentRoutes(r);
    r.group("/:sessionId", sessionMiddleware, (session) => {
      registerDiffRoutes(session);
      registerFileRoutes(session);
      registerGitRoutes(session);
      registerUploadRoutes(session);
    });
  });

  router.group(API.tasks, (r) => {
    registerTaskSessionRoutes(r);
  });

  router.group(API.project, projectMiddleware, (r) => {
    registerProjectSessionRoutes(r);
    registerTaskRoutes(r);
    registerCodeReviewRoutes(r);
  });

  return router;
}

import { createRouter } from "../router.js";
import type { RouteContext, Middleware } from "../router.js";
import { API } from "../api-paths.js";
import { notFound, badRequest } from "../errors.js";
import { getProject } from "../project-store.js";
import { parseIntParam } from "./validate.js";
import { ProjectModel } from "../models/projects.js";
import { resolveSource, SourceModel, SourceNotFoundError } from "../models/sources.js";
import { createBroadcast } from "../models/broadcast.js";
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
import { registerSourceRoutes } from "./sources.js";
import { registerSkillRoutes } from "./skills.js";
import { registerSettingsRoutes } from "./settings.js";
import { registerModelsRoutes } from "./models.js";
import { registerOAuthRoutes } from "./oauth.js";
import { registerAuthRoutes } from "./auth.js";
import { registerAttachmentRoutes } from "./attachments.js";
import { registerClientTelemetryRoutes } from "./client-telemetry.js";
import { registerCodeReviewRoutes } from "./code-reviews.js";

export type ProjectRouteContext = RouteContext & { project: ProjectModel };

/** The source a project request works in: `?sourceId=` when the client names one, else the project's
 * default source. */
function requestSource(projectId: number, url: URL) {
  const param = url.searchParams.get("sourceId");
  const sourceId = param === null ? null : Number(param);
  if (sourceId !== null && !Number.isSafeInteger(sourceId)) badRequest("sourceId must be an integer");
  try {
    return resolveSource(projectId, sourceId);
  } catch (err) {
    if (err instanceof SourceNotFoundError) notFound(err.message);
    throw err;
  }
}

const projectMiddleware: Middleware<{ project: ProjectModel }> = (ctx) => {
  const projectId = parseIntParam(ctx.params, "id");
  const project = getProject(projectId);
  if (!project) notFound("Project not found");
  Object.assign(ctx, {
    project: new ProjectModel(
      project.id, createBroadcast(ctx.state.clients), new SourceModel(ctx.state.nodes, requestSource(project.id, ctx.url)),
    ),
  });
};

export function buildRouter() {
  const router = createRouter();

  registerHealthRoutes(router);
  if (process.env.REINS_DEV === "1") registerClientTelemetryRoutes(router);
  registerProjectRoutes(router);
  registerNodeRoutes(router);
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
    registerCodeReviewRoutes(r);
    registerGitRoutes(r);
    registerUploadRoutes(r);
    registerSourceRoutes(r);
    registerSkillRoutes(r);
  });

  return router;
}

/**
 * File Content Route (project-scoped)
 *
 * Thin adapter that delegates to ProjectModel.serveFile() for content
 * reading, MIME detection, and filename extraction. Builds the HTTP
 * response (headers + body) from the returned metadata.
 */

import type { RouterGroup } from "../router.js";
import type { ProjectRouteContext } from "./index.js";
import { badRequest, notFound } from "../errors.js";
import { PathTraversalError, FileNotFoundError } from "../models/projects.js";

export function registerFileRoutes(router: RouterGroup<ProjectRouteContext>) {
  router.get("/file", async (ctx) => {
    const filePath = ctx.url.searchParams.get("path");
    if (!filePath) badRequest("Missing ?path= parameter");

    const ref = ctx.url.searchParams.get("ref");
    const download = ctx.url.searchParams.get("download") === "1";

    try {
      const { content, mimeType, filename } = await ctx.project.serveFile(filePath!, ref, download);

      const headers: Record<string, string> = { "Content-Type": mimeType };
      if (download) {
        headers["Content-Disposition"] = `attachment; filename="${filename}"`;
      }

      return new Response(content, { headers });
    } catch (err: any) {
      if (err instanceof PathTraversalError) badRequest(err.message);
      if (err instanceof FileNotFoundError) notFound(err.message);
      throw err;
    }
  });
}

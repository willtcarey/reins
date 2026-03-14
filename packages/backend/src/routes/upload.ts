/**
 * File Upload Route (project-scoped)
 *
 * Accepts multipart/form-data with one or more files under the "files"
 * field name. An optional `?path=` query parameter specifies the target
 * subdirectory within the project.
 *
 * Delegates all validation and disk I/O to ProjectModel.writeFiles().
 */

import type { RouterGroup } from "../router.js";
import type { ProjectRouteContext } from "./index.js";
import { badRequest } from "../errors.js";
import {
  PathTraversalError,
  NoFilesError,
  InvalidFilenameError,
} from "../models/projects.js";

export function registerUploadRoutes(router: RouterGroup<ProjectRouteContext>) {
  router.post("/upload", async (ctx) => {
    const formData = await ctx.req.formData();
    const files = formData.getAll("files").filter(
      (f): f is File => typeof f === "object" && f !== null && "arrayBuffer" in f,
    );

    const subPath = ctx.url.searchParams.get("path") ?? "";

    try {
      const result = await ctx.project.writeFiles(
        files.map((f) => ({ name: f.name, data: f })),
        subPath,
      );
      return Response.json(result);
    } catch (err) {
      if (
        err instanceof PathTraversalError ||
        err instanceof NoFilesError ||
        err instanceof InvalidFilenameError
      ) {
        badRequest(err.message);
      }
      throw err;
    }
  });
}

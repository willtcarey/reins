/**
 * File Upload Route (project-scoped)
 *
 * Accepts multipart/form-data with one or more files under the "files"
 * field name. An optional `?path=` query parameter specifies the target
 * subdirectory within the project. Files are written to the project
 * directory on disk.
 *
 * Validates against path traversal in both the query param and filenames.
 */

import { resolve, normalize, join, basename } from "path";
import { mkdirSync } from "fs";
import type { RouterGroup } from "../router.js";
import type { ProjectRouteContext } from "./index.js";
import { badRequest } from "../errors.js";
import { PathTraversalError } from "../models/projects.js";

/**
 * Check that a resolved path stays within the project directory.
 */
function assertInsideProject(projectDir: string, resolved: string): void {
  const normalizedProject = normalize(projectDir);
  if (!resolved.startsWith(normalizedProject + "/") && resolved !== normalizedProject) {
    throw new PathTraversalError();
  }
}

export function registerUploadRoutes(router: RouterGroup<ProjectRouteContext>) {
  router.post("/upload", async (ctx) => {
    const formData = await ctx.req.formData();
    const files = formData.getAll("files");

    // Filter to actual File/Blob objects with a name
    const fileEntries = files.filter((f): f is File =>
      typeof f === "object" && f !== null && "arrayBuffer" in f,
    ) as File[];
    if (fileEntries.length === 0) {
      badRequest("No files provided");
    }

    const subPath = ctx.url.searchParams.get("path") ?? "";

    // Validate subdirectory path
    if (subPath) {
      const resolvedDir = resolve(ctx.project.projectDir, subPath);
      try {
        assertInsideProject(ctx.project.projectDir, resolvedDir);
      } catch {
        badRequest("Path traversal not allowed");
      }
    }

    const uploaded: string[] = [];

    for (const file of fileEntries) {
      // Use only the basename to prevent directory traversal via filename
      const rawName = (file as File).name ?? (file as any).filename;
      if (!rawName) {
        badRequest("File is missing a filename");
      }
      const safeName = basename(rawName);
      if (!safeName || safeName === "." || safeName === "..") {
        badRequest("Invalid filename");
      }

      // Validate the full resolved destination
      const destDir = subPath
        ? resolve(ctx.project.projectDir, subPath)
        : ctx.project.projectDir;
      const destPath = resolve(destDir, safeName);

      try {
        assertInsideProject(ctx.project.projectDir, destPath);
      } catch {
        badRequest("Path traversal not allowed in filename");
      }

      // Ensure target directory exists
      mkdirSync(destDir, { recursive: true });

      // Write file — use Bun.write which handles large files efficiently
      await Bun.write(destPath, file);

      const relativePath = subPath ? join(subPath, safeName) : safeName;
      uploaded.push(relativePath);
    }

    return Response.json({ uploaded });
  });
}

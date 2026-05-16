/**
 * File Routes (project-scoped)
 *
 * GET /files         — list non-ignored files in the project
 * GET /files/content — read a single file's content (working tree or git ref)
 */

import type { RouterGroup } from "../router.js";
import type { ProjectRouteContext } from "./index.js";
import { badRequest, notFound } from "../errors.js";
import { PathTraversalError, FileNotFoundError } from "../models/projects.js";

export function registerFileRoutes(router: RouterGroup<ProjectRouteContext>) {
  /** List all non-ignored files. */
  router.get("/files", async (ctx) => {
    const files = await ctx.project.listFiles();
    return Response.json({ files });
  });

  /** List entries in a directory (one level). */
  router.get("/files/tree", async (ctx) => {
    const subPath = ctx.url.searchParams.get("path") || ".";

    try {
      const entries = ctx.project.listDirectory(subPath);
      return Response.json({ entries });
    } catch (err: any) {
      if (err instanceof PathTraversalError) badRequest(err.message);
      if (err instanceof FileNotFoundError) notFound(err.message);
      throw err;
    }
  });

  /** Read a single file's content. */
  router.get("/files/content", async (ctx) => {
    const filePath = ctx.url.searchParams.get("path");
    if (!filePath) badRequest("Missing ?path= parameter");

    const ref = ctx.url.searchParams.get("ref");
    const download = ctx.url.searchParams.get("download") === "1";

    try {
      const { content, mimeType, filename } = await ctx.project.serveFile(filePath!, ref);

      const headers: Record<string, string> = {
        "Content-Type": mimeType,
        "Cache-Control": "no-cache, no-store",
      };
      if (download) {
        headers["Content-Disposition"] = `attachment; filename="${filename}"`;
      }

      // Copy to a fresh ArrayBuffer to satisfy TS 5.7's stricter
      // ArrayBufferView<ArrayBuffer> constraint in BodyInit/BlobPart.
      const buf = new ArrayBuffer(content.byteLength);
      new Uint8Array(buf).set(content);
      return new Response(buf, { headers });
    } catch (err: any) {
      if (err instanceof PathTraversalError) badRequest(err.message);
      if (err instanceof FileNotFoundError) notFound(err.message);
      throw err;
    }
  });
}

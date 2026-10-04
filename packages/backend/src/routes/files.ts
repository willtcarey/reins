/**
 * File Routes (project-scoped)
 *
 * GET /files         — list non-ignored files in the project
 * GET /files/tree    — list one directory
 * GET /files/content — read a single file's content (working tree or git ref)
 *
 * Listing reads the project's default source checkout through its node; with that node offline it
 * answers 503. Content is still read from the server's checkout.
 */

import type { RouterGroup } from "../router.js";
import type { ProjectRouteContext } from "./index.js";
import { badRequest, notFound, serviceUnavailable } from "../errors.js";
import { PathTraversalError, FileNotFoundError, CheckoutUnavailableError } from "../models/projects.js";
import {
  InvalidWorkspacePathError,
  WorkspaceFileNotFoundError,
} from "../models/file-system.js";

const TEXT_APPLICATION_TYPES = new Set([
  "application/json",
  "application/javascript",
  "application/typescript",
  "application/xml",
  "application/yaml",
  "application/toml",
  "application/x-sh",
  "application/x-shellscript",
  "application/x-ruby",
  "application/x-python",
  "application/x-perl",
  "application/x-php",
  "application/x-awk",
  "application/x-lua",
  "application/x-makefile",
  "application/x-httpd-php",
]);

function isTextMimeType(mimeType: string): boolean {
  if (mimeType.startsWith("text/")) return true;
  return TEXT_APPLICATION_TYPES.has(mimeType);
}

function isInlineBinaryPreviewMimeType(mimeType: string): boolean {
  return mimeType.startsWith("image/") || mimeType === "application/pdf";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function registerFileRoutes(router: RouterGroup<ProjectRouteContext>) {
  /** List all non-ignored files. */
  router.get("/files", async (ctx) => {
    try {
      const files = await ctx.project.listFiles(ctx.state.nodes);
      return Response.json({ files });
    } catch (err) {
      if (err instanceof CheckoutUnavailableError) serviceUnavailable(err.message);
      throw err;
    }
  });

  /** List entries in a directory (one level). */
  router.get("/files/tree", async (ctx) => {
    const subPath = ctx.url.searchParams.get("path") || ".";

    try {
      const entries = await ctx.project.listDirectory(ctx.state.nodes, subPath);
      return Response.json({ entries });
    } catch (err) {
      if (err instanceof PathTraversalError) badRequest(err.message);
      if (err instanceof FileNotFoundError) notFound(err.message);
      if (err instanceof CheckoutUnavailableError) serviceUnavailable(err.message);
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
      const source = await ctx.project.workspace.openFile(filePath!, ref);
      const headers: Record<string, string> = {
        "Content-Type": source.mimeType,
        "Content-Length": String(source.size),
        "Cache-Control": "no-cache, no-store",
      };
      if (download) {
        headers["Content-Disposition"] = `attachment; filename="${source.filename}"`;
      }

      const isText = source.size === 0 || isTextMimeType(source.mimeType);
      const isInlinePreview = isInlineBinaryPreviewMimeType(source.mimeType);
      if (!download && !isText && !isInlinePreview) {
        const message = `Binary file (${formatSize(source.size)}). Download to view.`;
        return new Response(message, {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-cache, no-store",
            "X-Reins-Content-Kind": "binary-placeholder",
          },
        });
      }

      return new Response(source.openBody(), { headers });
    } catch (err: any) {
      if (err instanceof InvalidWorkspacePathError) badRequest(err.message);
      if (err instanceof WorkspaceFileNotFoundError) notFound(err.message);
      throw err;
    }
  });
}

/**
 * File Routes (project-scoped)
 *
 * GET /files         — list non-ignored files in the project
 * GET /files/content — read a single file's content (working tree or git ref)
 */

import { stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import type { RouterGroup } from "../router.js";
import type { ProjectRouteContext } from "./index.js";
import { badRequest, notFound } from "../errors.js";
import { PathTraversalError, FileNotFoundError } from "../models/projects.js";
import { detectMimeTypeFromBytes, detectMimeTypeFromFile } from "../mime.js";
import {
  getCurrentBranch,
  getGitBlobInfo,
  readGitBlobPrefix,
  streamGitBlob,
} from "../git.js";

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

interface FileContentSource {
  filename: string;
  mimeType: string;
  size: number;
  openBody: () => Blob | ReadableStream<Uint8Array>;
}

function assertInsideProject(projectDir: string, filePath: string): string {
  const resolved = resolve(projectDir, filePath);
  const rel = relative(projectDir, resolved);
  if (rel === "" || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    throw new PathTraversalError();
  }
  return resolved;
}

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

async function shouldReadFromGit(projectDir: string, ref: string | null): Promise<boolean> {
  if (!ref) return false;
  const currentBranch = await getCurrentBranch(projectDir);
  return currentBranch !== ref;
}

async function openWorkingTreeFile(projectDir: string, filePath: string): Promise<FileContentSource> {
  const resolved = assertInsideProject(projectDir, filePath);
  let stats;
  try {
    stats = await stat(resolved);
  } catch {
    throw new FileNotFoundError();
  }
  if (!stats.isFile()) {
    throw new FileNotFoundError();
  }

  return {
    filename: basename(filePath) || filePath,
    mimeType: await detectMimeTypeFromFile(resolved),
    size: stats.size,
    openBody: () => Bun.file(resolved),
  };
}

async function openGitFile(projectDir: string, filePath: string, ref: string): Promise<FileContentSource> {
  assertInsideProject(projectDir, filePath);

  try {
    const { objectId, size } = await getGitBlobInfo(projectDir, ref, filePath);
    const prefix = await readGitBlobPrefix(projectDir, objectId);
    return {
      filename: basename(filePath) || filePath,
      mimeType: await detectMimeTypeFromBytes(prefix),
      size,
      openBody: () => streamGitBlob(projectDir, objectId),
    };
  } catch {
    throw new FileNotFoundError("File not found in ref");
  }
}

async function openFileContent(projectDir: string, filePath: string, ref: string | null): Promise<FileContentSource> {
  return await shouldReadFromGit(projectDir, ref)
    ? openGitFile(projectDir, filePath, ref!)
    : openWorkingTreeFile(projectDir, filePath);
}

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
      const source = await openFileContent(ctx.project.projectDir, filePath!, ref);
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
          },
        });
      }

      return new Response(source.openBody(), { headers });
    } catch (err: any) {
      if (err instanceof PathTraversalError) badRequest(err.message);
      if (err instanceof FileNotFoundError) notFound(err.message);
      throw err;
    }
  });
}

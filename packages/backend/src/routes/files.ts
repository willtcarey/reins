/**
 * File Routes
 *
 * A directory on a node, named by the node and its absolute path (`root`), whether or not a session works
 * there (`sourceAt`): the frontend's `files` reads a source through them.
 *
 *   GET  /api/nodes/:nodeId/files?root=                — list the non-ignored files under it (git)
 *   GET  /api/nodes/:nodeId/files/tree?root=&path=     — list one directory (`.`, the root, by default)
 *   GET  /api/nodes/:nodeId/files/content?root=&path=  — read one file (`ref=`: at a git ref; `download=1`)
 *   POST /api/nodes/:nodeId/files/upload?root=&path=   — write files (multipart, under "files") into a folder
 *
 * A `path` outside `root` is refused (400). An unknown or removed node is 404, a relative root 400. A file's
 * content says how it is shown (`X-Reins-Content-Kind`: `text`, `preview` for images and PDFs, `binary`), so
 * the browser keeps no MIME rules of its own; a binary file's body is a placeholder unless downloaded.
 *
 * Session-scoped, for the diff views, which read the session's checkout at its branch:
 *
 *   GET /api/sessions/:sessionId/files/content?path=   — as above, in the session's checkout
 *
 * Each reads through the node; with that node offline it answers 503.
 */

import type { RouteContext, RouterGroup } from "../router.js";
import type { SessionRouteContext } from "./index.js";
import { API } from "../api-paths.js";
import { badRequest, notFound } from "../errors.js";
import { NodeNotFoundError } from "../models/nodes.js";
import {
  CheckoutNotFoundError,
  FileNotFoundError,
  FileWriteRefusedError,
  InvalidFilenameError,
  NoFilesError,
  PathTraversalError,
  sourceAt,
  type SourceModel,
} from "../models/sources.js";
import { InvalidWorkspacePathError, WorkspaceFileNotFoundError } from "../models/file-system.js";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The file models' errors as HTTP errors; anything else is rethrown. */
function translateFileError(error: unknown): never {
  if (error instanceof NodeNotFoundError || error instanceof FileNotFoundError || error instanceof WorkspaceFileNotFoundError) notFound(error.message);
  if (
    error instanceof CheckoutNotFoundError || error instanceof PathTraversalError || error instanceof InvalidWorkspacePathError
    || error instanceof FileWriteRefusedError || error instanceof NoFilesError || error instanceof InvalidFilenameError
  ) badRequest(error.message);
  throw error;
}

/** The directory named by `:nodeId` and `?root=`. */
function nodeSource(ctx: RouteContext): SourceModel {
  const root = ctx.url.searchParams.get("root");
  if (!root) badRequest("Missing ?root= parameter");
  return sourceAt(ctx.params.nodeId!, root, ctx.models.nodes);
}

/** `X-Reins-Content-Kind` is the file's kind (`FileKind`); a binary file's body is a placeholder unless downloaded. */
async function fileContent(source: SourceModel, url: URL): Promise<Response> {
  const filePath = url.searchParams.get("path");
  if (!filePath) badRequest("Missing ?path= parameter");
  const download = url.searchParams.get("download") === "1";

  const file = await source.openFile(filePath, url.searchParams.get("ref"));
  const headers: Record<string, string> = { "Cache-Control": "no-cache, no-store", "X-Reins-Content-Kind": file.kind };
  if (file.kind === "binary" && !download) {
    return new Response(`Binary file (${formatSize(file.size)}). Download to view.`, {
      headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  headers["Content-Type"] = file.mimeType;
  headers["Content-Length"] = String(file.size);
  if (download) headers["Content-Disposition"] = `attachment; filename="${file.filename}"`;
  return new Response(file.openBody(), { headers });
}

/** Runs a file route, its models' errors answered as HTTP errors. */
function handled<Ctx extends RouteContext>(handler: (ctx: Ctx) => Promise<Response>): (ctx: Ctx) => Promise<Response> {
  return async (ctx) => {
    try {
      return await handler(ctx);
    } catch (error) {
      return translateFileError(error);
    }
  };
}

export function registerNodeFileRoutes(router: RouterGroup) {
  const files = `${API.nodes}/:nodeId/files`;

  router.get(files, handled(async (ctx) => Response.json({ files: await nodeSource(ctx).listFiles() })));

  router.get(`${files}/tree`, handled(async (ctx) =>
    Response.json({ entries: await nodeSource(ctx).listDirectory(ctx.url.searchParams.get("path") || ".") })));

  router.get(`${files}/content`, handled((ctx) => fileContent(nodeSource(ctx), ctx.url)));

  router.post(`${files}/upload`, handled(async (ctx) => {
    const source = nodeSource(ctx);
    const formData = await ctx.req.formData();
    const uploads = formData.getAll("files").filter(
      (f): f is File => typeof f === "object" && f !== null && "arrayBuffer" in f,
    );
    return Response.json(await source.writeFiles(uploads.map((f) => ({ name: f.name, data: f })), ctx.url.searchParams.get("path") ?? ""));
  }));
}

export function registerSessionFileRoutes(router: RouterGroup<SessionRouteContext>) {
  router.get("/files/content", handled((ctx) => fileContent(ctx.session.source, ctx.url)));
}

/**
 * File Content Route (project-scoped)
 *
 * Returns the raw content of a file in the working tree.
 * Used by the frontend to render markdown previews of changed files.
 */

import { resolve, normalize } from "path";
import type { RouterGroup, RouteContext } from "../router.js";
import { badRequest, notFound } from "../errors.js";

export function registerFileRoutes(router: RouterGroup) {
  router.get("/file", async (ctx: RouteContext) => {
    const projectDir = (ctx as any).projectDir as string;
    const filePath = ctx.url.searchParams.get("path");

    if (!filePath) badRequest("Missing ?path= parameter");

    // Prevent path traversal
    const resolved = resolve(projectDir, filePath!);
    const normalizedProject = normalize(projectDir);
    if (!resolved.startsWith(normalizedProject + "/") && resolved !== normalizedProject) {
      badRequest("Path traversal not allowed");
    }

    try {
      const file = Bun.file(resolved);
      const content = await file.text();
      return new Response(content, {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    } catch {
      notFound("File not found");
    }
  });
}

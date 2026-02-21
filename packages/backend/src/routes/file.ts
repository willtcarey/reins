/**
 * File Content Route (project-scoped)
 *
 * Returns the raw content of a file. When a `ref` query parameter is
 * provided (e.g. a branch name), the content is read from that git ref
 * via `git show ref:path` — this works even when the branch is not
 * checked out. Without `ref`, the file is read from the working tree.
 * Used by the frontend to render markdown previews of changed files.
 */

import { resolve, normalize } from "path";
import type { RouterGroup, RouteContext } from "../router.js";
import { badRequest, notFound } from "../errors.js";
import { getCurrentBranch } from "../git.js";

export function registerFileRoutes(router: RouterGroup) {
  router.get("/file", async (ctx: RouteContext) => {
    const projectDir = (ctx as any).projectDir as string;
    const filePath = ctx.url.searchParams.get("path");
    const ref = ctx.url.searchParams.get("ref");

    if (!filePath) badRequest("Missing ?path= parameter");

    // Prevent path traversal (relevant for working-tree reads, but we
    // validate regardless so that the path is always sane).
    const resolved = resolve(projectDir, filePath!);
    const normalizedProject = normalize(projectDir);
    if (!resolved.startsWith(normalizedProject + "/") && resolved !== normalizedProject) {
      badRequest("Path traversal not allowed");
    }

    // Decide whether to read from git or the working tree.
    // If a ref is given but it matches the currently checked-out branch,
    // prefer the working tree so that uncommitted changes are visible.
    let useGit = false;
    if (ref) {
      const currentBranch = await getCurrentBranch(projectDir);
      useGit = currentBranch !== ref;
    }

    if (useGit) {
      // Read from the git ref — works for any branch/commit, even if
      // not currently checked out.
      try {
        const proc = Bun.spawn(["git", "show", `${ref}:${filePath}`], {
          cwd: projectDir,
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        const exitCode = await proc.exited;
        if (exitCode !== 0) {
          notFound("File not found in ref");
        }
        return new Response(stdout, {
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      } catch {
        notFound("File not found in ref");
      }
    }

    // Read from working tree — either no ref was given, or the ref
    // matches the checked-out branch (so we pick up uncommitted edits).
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

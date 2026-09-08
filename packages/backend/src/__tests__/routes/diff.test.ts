import { describe, test, expect, beforeEach } from "bun:test";
import { writeFileSync } from "fs";
import { join } from "path";
import { useTestDb } from "../helpers/test-db.js";
import { makeRequest } from "../helpers/request.js";
import { createServerState } from "../helpers/server-state.js";
import { useTestRepo, commitFile, git } from "../helpers/test-repo.js";
import { buildRouter } from "../../routes/index.js";
import { createProject } from "../../project-store.js";

describe("diff routes", () => {
  let state: ReturnType<typeof createServerState>;
  let router: ReturnType<typeof buildRouter>;
  let projectId: number;

  useTestDb();
  const repo = useTestRepo();

  beforeEach(() => {
    state = createServerState();
    router = buildRouter();
    const p = createProject("Test Project", repo.dir);
    projectId = p.id;
  });

  describe("GET /api/projects/:id/diff/files", () => {
    test("returns empty files when no changes (branch mode)", async () => {
      const res = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/diff/files?mode=branch`),
        state,
      );
      expect(res!.status).toBe(200);
      const body = await res!.json();
      expect(body.files).toEqual([]);
      expect(body.baseBranch).toBe("main");
    });

    test("returns changed files in branch mode", async () => {
      // Create a feature branch with a change
      const proc = Bun.spawn(["git", "checkout", "-b", "feature/test"], { cwd: repo.dir, stdout: "pipe", stderr: "pipe" });
      await proc.exited;
      await commitFile(repo.dir, "new-file.txt", "hello world", "Add new file");

      const res = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/diff/files?mode=branch&branch=feature/test`),
        state,
      );
      expect(res!.status).toBe(200);
      const body = await res!.json();
      expect(body.files.length).toBeGreaterThan(0);
      expect(body.branch).toBe("feature/test");
    });

    test("returns uncommitted changes in uncommitted mode", async () => {
      // Make an uncommitted change
      writeFileSync(join(repo.dir, "uncommitted.txt"), "uncommitted content");
      // Stage it
      const proc = Bun.spawn(["git", "add", "uncommitted.txt"], { cwd: repo.dir, stdout: "pipe", stderr: "pipe" });
      await proc.exited;

      const res = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/diff/files?mode=uncommitted`),
        state,
      );
      expect(res!.status).toBe(200);
      const body = await res!.json();
      expect(body.files.length).toBeGreaterThan(0);
    });
  });

  describe("GET /api/projects/:id/diff", () => {
    test("does not expose the retired parsed diff endpoint", async () => {
      const res = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/diff?mode=branch`),
        state,
      );
      expect(res).toBeNull();
    });
  });

  describe("GET /api/projects/:id/diff/patch", () => {
    test("returns raw patch text with a diff content type", async () => {
      await git(repo.dir, ["checkout", "-b", "feature/raw-patch"]);
      await commitFile(repo.dir, "patch-file.txt", "line 1\nline 2\n", "Add patch file");
      await git(repo.dir, ["checkout", "main"]);

      const res = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/diff/patch?mode=branch&branch=feature/raw-patch`),
        state,
      );

      expect(res!.status).toBe(200);
      expect(res!.headers.get("Content-Type")).toStartWith("text/x-diff");
      const patch = await res!.text();
      expect(patch).toContain("diff --git a/patch-file.txt b/patch-file.txt");
      expect(patch).toContain("+line 2");
    });
  });
});

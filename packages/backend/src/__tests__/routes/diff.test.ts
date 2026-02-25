import { describe, test, expect, beforeEach } from "bun:test";
import { writeFileSync } from "fs";
import { join } from "path";
import { useTestDb } from "../helpers/test-db.js";
import { createTestState } from "../helpers/test-state.js";
import { useTestRepo, commitFile } from "../helpers/test-repo.js";
import { buildRouter } from "../../routes/index.js";
import { createProject } from "../../project-store.js";

function makeRequest(method: string, path: string): Request {
  return new Request(`http://localhost${path}`, { method });
}

describe("diff routes", () => {
  let state: ReturnType<typeof createTestState>;
  let router: ReturnType<typeof buildRouter>;
  let projectId: number;

  useTestDb();
  const repo = useTestRepo();

  beforeEach(() => {
    state = createTestState();
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
    test("returns empty diff when no changes", async () => {
      const res = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/diff?mode=branch`),
        state,
      );
      expect(res!.status).toBe(200);
      const body = await res!.json();
      expect(body.files).toEqual([]);
    });

    test("returns parsed diff hunks for branch changes", async () => {
      const proc = Bun.spawn(["git", "checkout", "-b", "feature/diff-test"], { cwd: repo.dir, stdout: "pipe", stderr: "pipe" });
      await proc.exited;
      await commitFile(repo.dir, "diff-file.txt", "line 1\nline 2\n", "Add diff file");

      const res = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/diff?mode=branch&branch=feature/diff-test`),
        state,
      );
      expect(res!.status).toBe(200);
      const body = await res!.json();
      expect(body.files.length).toBeGreaterThan(0);
      expect(body.branch).toBe("feature/diff-test");
    });

    test("respects context query param", async () => {
      const proc = Bun.spawn(["git", "checkout", "-b", "feature/ctx-test"], { cwd: repo.dir, stdout: "pipe", stderr: "pipe" });
      await proc.exited;
      await commitFile(repo.dir, "ctx-file.txt", "content", "Add context file");

      const res = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/diff?mode=branch&branch=feature/ctx-test&context=0`),
        state,
      );
      expect(res!.status).toBe(200);
      const body = await res!.json();
      // Just verify it doesn't error — context=0 is valid
      expect(body.files).toBeArray();
    });
  });
});

import { describe, test, expect, beforeEach } from "bun:test";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { useTestDb } from "../helpers/test-db.js";
import { createTestState } from "../helpers/test-state.js";
import { useTestRepo, commitFile } from "../helpers/test-repo.js";
import { buildRouter } from "../../routes/index.js";
import { createProject } from "../../project-store.js";

function makeRequest(method: string, path: string): Request {
  return new Request(`http://localhost${path}`, { method });
}

describe("file routes", () => {
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

  describe("GET /api/projects/:id/file", () => {
    test("returns file content from working tree", async () => {
      writeFileSync(join(repo.dir, "test.txt"), "hello world");

      const res = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/file?path=test.txt`),
        state,
      );
      expect(res!.status).toBe(200);
      const content = await res!.text();
      expect(content).toBe("hello world");
    });

    test("returns 400 when path param is missing", async () => {
      const res = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/file`),
        state,
      );
      expect(res!.status).toBe(400);
      const body = await res!.json();
      expect(body.error).toContain("path");
    });

    test("returns 400 for path traversal with ..", async () => {
      const res = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/file?path=../../../etc/passwd`),
        state,
      );
      expect(res!.status).toBe(400);
      const body = await res!.json();
      expect(body.error).toContain("traversal");
    });

    test("returns 404 for nonexistent file", async () => {
      const res = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/file?path=nonexistent.txt`),
        state,
      );
      expect(res!.status).toBe(404);
    });

    test("reads file from git ref when ref is a different branch", async () => {
      // Create a file on a different branch
      const proc = Bun.spawn(["git", "checkout", "-b", "feature/file-test"], { cwd: repo.dir, stdout: "pipe", stderr: "pipe" });
      await proc.exited;
      await commitFile(repo.dir, "branch-file.txt", "branch content", "Add branch file");
      // Switch back to main
      const proc2 = Bun.spawn(["git", "checkout", "main"], { cwd: repo.dir, stdout: "pipe", stderr: "pipe" });
      await proc2.exited;

      const res = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/file?path=branch-file.txt&ref=feature/file-test`),
        state,
      );
      expect(res!.status).toBe(200);
      const content = await res!.text();
      expect(content).toBe("branch content");
    });

    test("reads from working tree when ref matches current branch", async () => {
      // File exists in git and working tree, but working tree has uncommitted changes
      await commitFile(repo.dir, "wt-file.txt", "committed", "Add file");
      writeFileSync(join(repo.dir, "wt-file.txt"), "uncommitted changes");

      const res = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/file?path=wt-file.txt&ref=main`),
        state,
      );
      expect(res!.status).toBe(200);
      const content = await res!.text();
      expect(content).toBe("uncommitted changes");
    });

    test("reads nested file paths", async () => {
      mkdirSync(join(repo.dir, "subdir"), { recursive: true });
      writeFileSync(join(repo.dir, "subdir", "nested.txt"), "nested content");

      const res = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/file?path=subdir/nested.txt`),
        state,
      );
      expect(res!.status).toBe(200);
      const content = await res!.text();
      expect(content).toBe("nested content");
    });
  });
});

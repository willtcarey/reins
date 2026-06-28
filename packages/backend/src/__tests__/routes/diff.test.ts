import { describe, test, expect, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { useTestDb } from "../helpers/test-db.js";
import { makeRequest } from "../helpers/request.js";
import { createServerState } from "../helpers/server-state.js";
import { dedent } from "../helpers/text.js";
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

    test("matches /diff paths for a checked-out stacked branch with parent directory changes", async () => {
      await git(repo.dir, ["checkout", "-b", "feature/parent"]);
      mkdirSync(join(repo.dir, "nested", "parent-dir"), { recursive: true });
      await commitFile(repo.dir, "nested/parent-dir/a.txt", "from parent a\n", "Add parent directory file A");
      await commitFile(repo.dir, "nested/parent-dir/b.txt", "from parent b\n", "Add parent directory file B");

      await git(repo.dir, ["checkout", "-b", "feature/child"]);
      await commitFile(repo.dir, "child.txt", "from child\n", "Add child file");

      const [diffRes, filesRes] = await Promise.all([
        router.handle(makeRequest("GET", `/api/projects/${projectId}/diff?mode=branch&branch=feature/child`), state),
        router.handle(makeRequest("GET", `/api/projects/${projectId}/diff/files?mode=branch&branch=feature/child`), state),
      ]);

      expect(diffRes!.status).toBe(200);
      expect(filesRes!.status).toBe(200);

      const diffBody = await diffRes!.json();
      const filesBody = await filesRes!.json();
      const diffPaths = diffBody.files.map((file: any) => file.path).toSorted();
      const filePaths = filesBody.files.map((file: any) => file.path).toSorted();

      expect(diffPaths).toContain("nested/parent-dir/a.txt");
      expect(diffPaths).toContain("nested/parent-dir/b.txt");
      for (const path of diffPaths) {
        expect(filePaths).toContain(path);
      }
    });

    test("matches /diff paths for an unchecked-out stacked branch with parent directory changes", async () => {
      await git(repo.dir, ["checkout", "-b", "feature/parent"]);
      mkdirSync(join(repo.dir, "nested", "parent-dir"), { recursive: true });
      await commitFile(repo.dir, "nested/parent-dir/a.txt", "from parent a\n", "Add parent directory file A");
      await commitFile(repo.dir, "nested/parent-dir/b.txt", "from parent b\n", "Add parent directory file B");

      await git(repo.dir, ["checkout", "-b", "feature/child"]);
      await commitFile(repo.dir, "child.txt", "from child\n", "Add child file");
      await git(repo.dir, ["checkout", "main"]);

      const [diffRes, filesRes] = await Promise.all([
        router.handle(makeRequest("GET", `/api/projects/${projectId}/diff?mode=branch&branch=feature/child`), state),
        router.handle(makeRequest("GET", `/api/projects/${projectId}/diff/files?mode=branch&branch=feature/child`), state),
      ]);

      expect(diffRes!.status).toBe(200);
      expect(filesRes!.status).toBe(200);

      const diffBody = await diffRes!.json();
      const filesBody = await filesRes!.json();
      const diffPaths = diffBody.files.map((file: any) => file.path).toSorted();
      const filePaths = filesBody.files.map((file: any) => file.path).toSorted();

      expect(diffPaths).toContain("nested/parent-dir/a.txt");
      expect(diffPaths).toContain("nested/parent-dir/b.txt");
      for (const path of diffPaths) {
        expect(filePaths).toContain(path);
      }
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

  describe("GET /api/projects/:id/diff/patch", () => {
    test("returns raw patch text for a branch diff", async () => {
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
      expect(patch).toBe(dedent`
        diff --git a/patch-file.txt b/patch-file.txt
        new file mode 100644
        index 0000000..7bba8c8
        --- /dev/null
        +++ b/patch-file.txt
        @@ -0,0 +1,2 @@
        +line 1
        +line 2
      `);
    });

    test("includes parent and child changes for a stacked branch", async () => {
      await git(repo.dir, ["checkout", "-b", "feature/parent"]);
      mkdirSync(join(repo.dir, "nested", "parent-dir"), { recursive: true });
      await commitFile(repo.dir, "nested/parent-dir/a.txt", "from parent a\n", "Add parent directory file A");

      await git(repo.dir, ["checkout", "-b", "feature/child"]);
      await commitFile(repo.dir, "child.txt", "from child\n", "Add child file");

      const res = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/diff/patch?mode=branch&branch=feature/child`),
        state,
      );

      expect(res!.status).toBe(200);
      const patch = await res!.text();
      expect(patch).toBe(dedent`
        diff --git a/child.txt b/child.txt
        new file mode 100644
        index 0000000..63bcb0c
        --- /dev/null
        +++ b/child.txt
        @@ -0,0 +1 @@
        +from child
        diff --git a/nested/parent-dir/a.txt b/nested/parent-dir/a.txt
        new file mode 100644
        index 0000000..70ebf70
        --- /dev/null
        +++ b/nested/parent-dir/a.txt
        @@ -0,0 +1 @@
        +from parent a
      `);
    });

    test("returns uncommitted working-tree changes in uncommitted mode", async () => {
      writeFileSync(join(repo.dir, "README.md"), "# Test Repo\nuncommitted line\n");

      const res = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/diff/patch?mode=uncommitted`),
        state,
      );

      expect(res!.status).toBe(200);
      const patch = await res!.text();
      expect(patch).toBe(dedent`
        diff --git a/README.md b/README.md
        index a8cdb91..beb0913 100644
        --- a/README.md
        +++ b/README.md
        @@ -1 +1,2 @@
         # Test Repo
        +uncommitted line
      `);
    });

    test("respects context query param", async () => {
      await commitFile(repo.dir, "context.txt", "line 1\nline 2\nline 3\nline 4\nline 5\n", "Add context file");
      await git(repo.dir, ["checkout", "-b", "feature/context-patch"]);
      writeFileSync(join(repo.dir, "context.txt"), "line 1\nline 2\nline THREE\nline 4\nline 5\n");
      await git(repo.dir, ["add", "context.txt"]);
      await git(repo.dir, ["commit", "-m", "Edit context file"]);

      const res = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/diff/patch?mode=branch&branch=feature/context-patch&context=0`),
        state,
      );

      expect(res!.status).toBe(200);
      const patch = await res!.text();
      expect(patch).toBe(dedent`
        diff --git a/context.txt b/context.txt
        index 94c99a3..ddf7aa5 100644
        --- a/context.txt
        +++ b/context.txt
        @@ -3 +3 @@ line 2
        -line 3
        +line THREE
      `);
    });

    test("includes untracked files as synthetic new-file diffs", async () => {
      writeFileSync(join(repo.dir, "untracked.txt"), "first\nsecond\n");

      const res = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/diff/patch?mode=uncommitted`),
        state,
      );

      expect(res!.status).toBe(200);
      const patch = await res!.text();
      expect(patch).toBe(dedent`
        diff --git a/untracked.txt b/untracked.txt
        new file mode 100644
        index 0000000..66a52ee
        --- /dev/null
        +++ b/untracked.txt
        @@ -0,0 +1,2 @@
        +first
        +second
      `);
    });
  });
});

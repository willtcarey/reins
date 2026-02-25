import { describe, test, expect, beforeEach } from "bun:test";
import { useTestDb } from "../helpers/test-db.js";
import { createTestState } from "../helpers/test-state.js";
import { useTestRepo, commitFile } from "../helpers/test-repo.js";
import { buildRouter } from "../../routes/index.js";
import { createProject } from "../../project-store.js";

function makeRequest(method: string, path: string, body?: any): Request {
  const opts: RequestInit = { method };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
    opts.headers = { "Content-Type": "application/json" };
  }
  return new Request(`http://localhost${path}`, opts);
}

describe("git routes", () => {
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

  describe("GET /api/projects/:id/git/spread", () => {
    test("returns 400 when branch param is missing", async () => {
      const res = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/git/spread`),
        state,
      );
      expect(res!.status).toBe(400);
      const body = await res!.json();
      expect(body.error).toContain("branch");
    });

    test("returns spread counts for a branch", async () => {
      // Create a branch with a commit
      const proc = Bun.spawn(["git", "checkout", "-b", "feature/spread"], { cwd: repo.dir, stdout: "pipe", stderr: "pipe" });
      await proc.exited;
      await commitFile(repo.dir, "spread.txt", "content", "Add file");
      // Switch back
      const proc2 = Bun.spawn(["git", "checkout", "main"], { cwd: repo.dir, stdout: "pipe", stderr: "pipe" });
      await proc2.exited;

      const res = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/git/spread?branch=feature/spread`),
        state,
      );
      expect(res!.status).toBe(200);
      const body = await res!.json();
      expect(body.branch).toBe("feature/spread");
      expect(body.aheadBase).toBeNumber();
      expect(body.behindBase).toBeNumber();
    });
  });

  describe("POST /api/projects/:id/git/push", () => {
    test("returns 400 when branch is missing", async () => {
      const res = await router.handle(
        makeRequest("POST", `/api/projects/${projectId}/git/push`, {}),
        state,
      );
      expect(res!.status).toBe(400);
      const body = await res!.json();
      expect(body.error).toContain("branch");
    });

    test("returns 400 when branch is empty string", async () => {
      const res = await router.handle(
        makeRequest("POST", `/api/projects/${projectId}/git/push`, { branch: "  " }),
        state,
      );
      expect(res!.status).toBe(400);
    });

    test("returns 500 when push fails (no remote)", async () => {
      // The test repo has no remote, so push should fail
      const proc = Bun.spawn(["git", "checkout", "-b", "feature/push-test"], { cwd: repo.dir, stdout: "pipe", stderr: "pipe" });
      await proc.exited;
      const proc2 = Bun.spawn(["git", "checkout", "main"], { cwd: repo.dir, stdout: "pipe", stderr: "pipe" });
      await proc2.exited;

      const res = await router.handle(
        makeRequest("POST", `/api/projects/${projectId}/git/push`, { branch: "feature/push-test" }),
        state,
      );
      expect(res!.status).toBe(500);
      const body = await res!.json();
      expect(body.error).toBeDefined();
    });
  });

  describe("POST /api/projects/:id/git/rebase", () => {
    test("returns 400 when branch is missing", async () => {
      const res = await router.handle(
        makeRequest("POST", `/api/projects/${projectId}/git/rebase`, {}),
        state,
      );
      expect(res!.status).toBe(400);
      const body = await res!.json();
      expect(body.error).toContain("branch");
    });

    test("returns 400 when branch is empty", async () => {
      const res = await router.handle(
        makeRequest("POST", `/api/projects/${projectId}/git/rebase`, { branch: "" }),
        state,
      );
      expect(res!.status).toBe(400);
    });

    test("rebases a branch onto base branch", async () => {
      // Create a branch with a commit
      const proc = Bun.spawn(["git", "checkout", "-b", "feature/rebase-test"], { cwd: repo.dir, stdout: "pipe", stderr: "pipe" });
      await proc.exited;
      await commitFile(repo.dir, "rebase.txt", "content", "Add file");
      const proc2 = Bun.spawn(["git", "checkout", "main"], { cwd: repo.dir, stdout: "pipe", stderr: "pipe" });
      await proc2.exited;

      const res = await router.handle(
        makeRequest("POST", `/api/projects/${projectId}/git/rebase`, { branch: "feature/rebase-test" }),
        state,
      );
      expect(res!.status).toBe(200);
      expect(await res!.json()).toEqual({ ok: true });
    });
  });
});

describe("git routes with remote", () => {
  let state: ReturnType<typeof createTestState>;
  let router: ReturnType<typeof buildRouter>;
  let projectId: number;

  useTestDb();
  const repo = useTestRepo({ withRemote: true });

  beforeEach(() => {
    state = createTestState();
    router = buildRouter();
    const p = createProject("Test Project", repo.dir);
    projectId = p.id;
  });

  test("push succeeds with remote configured", async () => {
    // Create a branch and push
    const proc = Bun.spawn(["git", "checkout", "-b", "feature/push-remote"], { cwd: repo.dir, stdout: "pipe", stderr: "pipe" });
    await proc.exited;
    await commitFile(repo.dir, "push-remote.txt", "content", "Add file");
    const proc2 = Bun.spawn(["git", "checkout", "main"], { cwd: repo.dir, stdout: "pipe", stderr: "pipe" });
    await proc2.exited;

    const res = await router.handle(
      makeRequest("POST", `/api/projects/${projectId}/git/push`, { branch: "feature/push-remote" }),
      state,
    );
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({ ok: true });
  });

  test("spread with fetch refreshes remote refs", async () => {
    const proc = Bun.spawn(["git", "checkout", "-b", "feature/spread-fetch"], { cwd: repo.dir, stdout: "pipe", stderr: "pipe" });
    await proc.exited;
    await commitFile(repo.dir, "fetch.txt", "content", "Add file");
    const proc2 = Bun.spawn(["git", "checkout", "main"], { cwd: repo.dir, stdout: "pipe", stderr: "pipe" });
    await proc2.exited;

    const res = await router.handle(
      makeRequest("GET", `/api/projects/${projectId}/git/spread?branch=feature/spread-fetch&fetch=true`),
      state,
    );
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body.branch).toBe("feature/spread-fetch");
    expect(body.aheadBase).toBeNumber();
  });
});

import { describe, test, expect, beforeEach } from "bun:test";
import { useTestDb } from "../helpers/test-db.js";
import { createTestState } from "../helpers/test-state.js";
import { useTestRepo, createTestRepo, commitFile } from "../helpers/test-repo.js";
import { buildRouter } from "../../routes/index.js";
import { createProject } from "../../project-store.js";
import { createTask, getTask } from "../../task-store.js";
import { createSession } from "../../session-store.js";

function makeRequest(method: string, path: string, body?: any): Request {
  const opts: RequestInit = { method };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
    opts.headers = { "Content-Type": "application/json" };
  }
  return new Request(`http://localhost${path}`, opts);
}

describe("task routes", () => {
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

  describe("GET /api/projects/:id/tasks", () => {
    test("returns empty list when no tasks", async () => {
      const res = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/tasks`),
        state,
      );
      expect(res!.status).toBe(200);
      expect(await res!.json()).toEqual([]);
    });

    test("returns tasks with diffStats for open tasks", async () => {
      // Create a branch and a task pointing to it
      const proc = Bun.spawn(["git", "checkout", "-b", "task/my-task"], { cwd: repo.dir, stdout: "pipe", stderr: "pipe" });
      await proc.exited;
      await commitFile(repo.dir, "new-file.txt", "hello", "Add file");
      // Switch back to main so getDiffStats can work
      const proc2 = Bun.spawn(["git", "checkout", "main"], { cwd: repo.dir, stdout: "pipe", stderr: "pipe" });
      await proc2.exited;

      createTask(projectId, "My Task", null, "task/my-task");

      const res = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/tasks`),
        state,
      );
      expect(res!.status).toBe(200);
      const body = await res!.json();
      expect(body).toHaveLength(1);
      expect(body[0].title).toBe("My Task");
      expect(body[0].diffStats).not.toBeNull();
    });
  });

  describe("GET /api/projects/:id/tasks/:taskId", () => {
    test("returns task with sessions", async () => {
      const task = createTask(projectId, "Test Task", null, "task/test");

      const res = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/tasks/${task.id}`),
        state,
      );
      expect(res!.status).toBe(200);
      const body = await res!.json();
      expect(body.id).toBe(task.id);
      expect(body.title).toBe("Test Task");
      expect(body.sessions).toBeArray();
    });

    test("returns 404 for nonexistent task", async () => {
      const res = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/tasks/9999`),
        state,
      );
      expect(res!.status).toBe(404);
    });
  });

  describe("PATCH /api/projects/:id/tasks/:taskId", () => {
    test("updates task title", async () => {
      const task = createTask(projectId, "Original", null, "task/original");

      const res = await router.handle(
        makeRequest("PATCH", `/api/projects/${projectId}/tasks/${task.id}`, { title: "Updated" }),
        state,
      );
      expect(res!.status).toBe(200);
      const body = await res!.json();
      expect(body.title).toBe("Updated");
    });

    test("returns 404 for nonexistent task", async () => {
      const res = await router.handle(
        makeRequest("PATCH", `/api/projects/${projectId}/tasks/9999`, { title: "Nope" }),
        state,
      );
      expect(res!.status).toBe(404);
    });
  });

  describe("DELETE /api/projects/:id/tasks/:taskId", () => {
    test("deletes task and cleans up branch", async () => {
      // Create the branch in git
      const proc = Bun.spawn(["git", "branch", "task/to-delete"], { cwd: repo.dir, stdout: "pipe", stderr: "pipe" });
      await proc.exited;

      const task = createTask(projectId, "To Delete", null, "task/to-delete");

      const res = await router.handle(
        makeRequest("DELETE", `/api/projects/${projectId}/tasks/${task.id}`),
        state,
      );
      expect(res!.status).toBe(200);
      expect(await res!.json()).toEqual({ ok: true });

      // Verify task is deleted from DB
      expect(getTask(task.id)).toBeNull();

      // Verify branch is deleted
      const branchProc = Bun.spawn(["git", "branch", "--list", "task/to-delete"], {
        cwd: repo.dir,
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(branchProc.stdout).text();
      await branchProc.exited;
      expect(stdout.trim()).toBe("");
    });

    test("returns 404 for nonexistent task", async () => {
      const res = await router.handle(
        makeRequest("DELETE", `/api/projects/${projectId}/tasks/9999`),
        state,
      );
      expect(res!.status).toBe(404);
    });

    test("returns 404 when task belongs to different project", async () => {
      const otherRepo = await createTestRepo();
      const otherProject = createProject("Other", otherRepo.dir);
      const task = createTask(otherProject.id, "Other Task", null, "task/other");

      const res = await router.handle(
        makeRequest("DELETE", `/api/projects/${projectId}/tasks/${task.id}`),
        state,
      );
      expect(res!.status).toBe(404);
      otherRepo.cleanup();
    });

    test("returns 409 when task has active streaming sessions", async () => {
      const task = createTask(projectId, "Active", null, "task/active");
      const sessionId = "session-1";
      createSession(sessionId, projectId, { taskId: task.id });

      // Add a streaming session to state
      state.sessions.set(sessionId, {
        session: { isStreaming: true } as any,
        id: sessionId,
        lastActivity: Date.now(),
      });

      const res = await router.handle(
        makeRequest("DELETE", `/api/projects/${projectId}/tasks/${task.id}`),
        state,
      );
      expect(res!.status).toBe(409);
      const body = await res!.json();
      expect(body.error).toContain("currently running");
    });

    test("cascades delete to sessions and messages", async () => {
      // Create branch for the task
      const proc = Bun.spawn(["git", "branch", "task/cascade"], { cwd: repo.dir, stdout: "pipe", stderr: "pipe" });
      await proc.exited;

      const task = createTask(projectId, "Cascade", null, "task/cascade");
      createSession("s1", projectId, { taskId: task.id });

      const res = await router.handle(
        makeRequest("DELETE", `/api/projects/${projectId}/tasks/${task.id}`),
        state,
      );
      expect(res!.status).toBe(200);
    });
  });

  describe("POST /api/projects/:id/tasks/generate", () => {
    test("returns 400 when prompt is empty", async () => {
      const res = await router.handle(
        makeRequest("POST", `/api/projects/${projectId}/tasks/generate`, { prompt: "" }),
        state,
      );
      expect(res!.status).toBe(400);
      const body = await res!.json();
      expect(body.error).toContain("Prompt");
    });

    test("returns 400 when prompt is whitespace only", async () => {
      const res = await router.handle(
        makeRequest("POST", `/api/projects/${projectId}/tasks/generate`, { prompt: "   " }),
        state,
      );
      expect(res!.status).toBe(400);
    });

    test("returns 400 when prompt field is missing", async () => {
      const res = await router.handle(
        makeRequest("POST", `/api/projects/${projectId}/tasks/generate`, {}),
        state,
      );
      expect(res!.status).toBe(400);
    });
  });

});

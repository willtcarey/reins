import { describe, test, expect, beforeEach } from "bun:test";
import { useTestDb } from "../helpers/test-db.js";
import { makeRequest } from "../helpers/request.js";
import { createServerState } from "../helpers/server-state.js";
import { useTestRepo, createTestRepo, commitFile } from "../helpers/test-repo.js";
import { buildRouter } from "../../routes/index.js";
import { createProject } from "../../project-store.js";
import { createTask, getTask, setTaskStatus } from "../../task-store.js";
import { createSession, updateSessionMetadata } from "../session-fixture.js";
import { getSession, updateActivityState } from "../../session-store.js";
import { useFakeNode } from "../helpers/fake-node.js";

describe("task routes", () => {
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

    test("paginates and searches closed tasks without changing workspace responses", async () => {
      for (const title of ["Router work", "Database work", "Design work"]) {
        const task = createTask(projectId, title, null, `task/${title}`);
        setTaskStatus(task.id, "closed");
      }

      const response = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/tasks?status=closed&limit=1&offset=0&search=work`),
        state,
      );
      const page = await response!.json();

      expect(page.items).toHaveLength(1);
      expect(page.hasMore).toBe(true);

      const searched = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/tasks?status=closed&limit=20&offset=0&search=router`),
        state,
      );
      expect((await searched!.json()).items.map((task: { title: string }) => task.title)).toEqual(["Router work"]);

      const unpaginated = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/tasks?status=closed`),
        state,
      );
      expect(await unpaginated!.json()).toHaveLength(3);
    });

    test("rejects invalid collection pagination", async () => {
      const response = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/tasks?limit=0`),
        state,
      );

      expect(response?.status).toBe(400);
    });

    test("filters task lists by status", async () => {
      createTask(projectId, "Open task", null, "task/open");
      const closed = createTask(projectId, "Closed task", null, "task/closed");
      setTaskStatus(closed.id, "closed");

      const openResponse = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/tasks?status=open`),
        state,
      );
      const closedResponse = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/tasks?status=closed`),
        state,
      );

      expect((await openResponse!.json()).map((task: { title: string }) => task.title)).toEqual(["Open task"]);
      expect((await closedResponse!.json()).map((task: { title: string }) => task.title)).toEqual(["Closed task"]);
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

    test("optionally includes archived sessions for History", async () => {
      const task = createTask(projectId, "Test Task", null, "task/test");
      createSession("current", projectId, { agentRuntimeType: "pi", taskId: task.id });
      createSession("archived", projectId, { agentRuntimeType: "pi", taskId: task.id });
      updateSessionMetadata("archived", { archived: true });

      const response = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/tasks/${task.id}?archived=include`),
        state,
      );

      expect((await response!.json()).sessions.map((session: { id: string }) => session.id).toSorted()).toEqual([
        "archived",
        "current",
      ]);
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

    test("clears a task description", async () => {
      const task = createTask(projectId, "Original", "Existing description", "task/original");

      const res = await router.handle(
        makeRequest("PATCH", `/api/projects/${projectId}/tasks/${task.id}`, { description: null }),
        state,
      );

      expect(res!.status).toBe(200);
      expect(await res!.json()).toMatchObject({ description: null });
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

    test("returns 409 when task has sessions running on their node", async () => {
      const task = createTask(projectId, "Active", null, "task/active");
      const sessionId = "session-1";
      createSession(sessionId, projectId, { agentRuntimeType: "pi", taskId: task.id });
      // Its node reported a run in progress.
      updateActivityState(sessionId, "running");

      const res = await router.handle(
        makeRequest("DELETE", `/api/projects/${projectId}/tasks/${task.id}`),
        state,
      );
      expect(res!.status).toBe(409);
      const body = await res!.json();
      expect(body.error).toContain("currently running");
    });

    test("deletes its sessions and tells their node to close them", async () => {
      // Create branch for the task
      const proc = Bun.spawn(["git", "branch", "task/cascade"], { cwd: repo.dir, stdout: "pipe", stderr: "pipe" });
      await proc.exited;

      const node = useFakeNode(state);
      await node.link.ready();
      const task = createTask(projectId, "Cascade", null, "task/cascade");
      createSession("s1", projectId, { agentRuntimeType: "pi", taskId: task.id });

      const res = await router.handle(
        makeRequest("DELETE", `/api/projects/${projectId}/tasks/${task.id}`),
        state,
      );
      expect(res!.status).toBe(200);
      expect(getSession("s1")).toBeNull();
      for (let i = 0; i < 100 && !node.closed.length; i++) await Bun.sleep(5);
      expect(node.closed).toEqual(["s1"]);
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
      expect(body.error).toContain("prompt");
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

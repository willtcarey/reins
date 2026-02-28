import { describe, test, expect, beforeEach } from "bun:test";
import { useTestDb } from "../helpers/test-db.js";
import { createTestState } from "../helpers/test-state.js";
import { useTestRepo } from "../helpers/test-repo.js";
import { buildRouter } from "../../routes/index.js";
import { createProject } from "../../project-store.js";
import { createSession } from "../../session-store.js";
import { createTask } from "../../task-store.js";

function makeRequest(method: string, path: string): Request {
  return new Request(`http://localhost${path}`, { method });
}

describe("task session routes (top-level)", () => {
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

  describe("GET /api/tasks/:taskId/sessions", () => {
    test("returns sessions for a task", async () => {
      const task = createTask(projectId, "With Sessions", null, "task/with-sessions");
      createSession("s1", projectId, { taskId: task.id });

      const res = await router.handle(
        makeRequest("GET", `/api/tasks/${task.id}/sessions`),
        state,
      );
      expect(res!.status).toBe(200);
      const body = await res!.json();
      expect(body).toBeArray();
      expect(body).toHaveLength(1);
    });

    test("returns 404 for nonexistent task", async () => {
      const res = await router.handle(
        makeRequest("GET", `/api/tasks/9999/sessions`),
        state,
      );
      expect(res!.status).toBe(404);
    });
  });
});

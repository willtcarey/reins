import { describe, test, expect, beforeEach } from "bun:test";
import { useTestDb } from "../helpers/test-db.js";
import { makeRequest } from "../helpers/request.js";
import { createServerState } from "../helpers/server-state.js";
import { useTestRepo } from "../helpers/test-repo.js";
import { buildRouter } from "../../routes/index.js";
import { createProject } from "../project-fixture.js";
import { createSession, updateActivityState, updateSessionMetadata } from "../session-fixture.js";
import { createTask } from "../../task-store.js";
import { persistCanonicalMessages } from "../helpers/canonical-messages.js";

function textContent(text: string) {
  return [{ type: "text" as const, text }];
}

describe("project session routes", () => {
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

  describe("GET /api/projects/:id/sessions", () => {
    test("returns empty list when no sessions", async () => {
      const res = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/sessions`),
        state,
      );
      expect(res!.status).toBe(200);
      expect(await res!.json()).toEqual([]);
    });

    test("returns scratch sessions with camelCase list shape", async () => {
      createSession("scratch-1", projectId, { agentRuntimeType: "pi",});
      persistCanonicalMessages("scratch-1", [{ role: "user", content: textContent("hello") }]);
      updateActivityState("scratch-1", "running");

      const res = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/sessions`),
        state,
      );
      expect(res!.status).toBe(200);
      const body = await res!.json();
      expect(body).toHaveLength(1);
      expect(body[0]).toMatchObject({
        id: "scratch-1",
        projectId,
        taskId: null,
        parentSessionId: null,
        messageCount: 1,
        firstMessage: "hello",
        activityState: "running",
        pinnedAt: null,
        archivedAt: null,
      });
      expect(body[0]).toHaveProperty("createdAt");
      expect(body[0]).toHaveProperty("updatedAt");
      expect(body[0]).not.toHaveProperty("project_id");
      expect(body[0]).not.toHaveProperty("message_count");
      expect(body[0]).not.toHaveProperty("activity_state");
    });

    test("paginates archived sessions without changing unpaginated workspace responses", async () => {
      for (const id of ["archived-1", "archived-2", "archived-3"]) {
        createSession(id, projectId, { agentRuntimeType: "pi" });
        updateSessionMetadata(id, { archived: true });
      }

      const response = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/sessions?archived=only&limit=2&offset=0`),
        state,
      );
      const page = await response!.json();

      expect(page.items).toHaveLength(2);
      expect(page.hasMore).toBe(true);

      const unpaginated = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/sessions?archived=only`),
        state,
      );
      expect(await unpaginated!.json()).toHaveLength(3);
    });

    test("searches archived sessions before paginating", async () => {
      createSession("matching", projectId, { agentRuntimeType: "pi" });
      createSession("other", projectId, { agentRuntimeType: "pi" });
      updateSessionMetadata("matching", { name: "Router research", archived: true });
      updateSessionMetadata("other", { name: "Unrelated", archived: true });

      const response = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/sessions?archived=only&limit=20&offset=0&search=router`),
        state,
      );
      const page = await response!.json();

      expect(page.items.map((session: { id: string }) => session.id)).toEqual(["matching"]);
      expect(page.hasMore).toBe(false);
    });

    test("returns archived sessions from every project scope with task context", async () => {
      const task = createTask(projectId, "Open task", null, "task/open");
      createSession("active-scratch", projectId, { agentRuntimeType: "pi" });
      createSession("archived-scratch", projectId, { agentRuntimeType: "pi" });
      createSession("archived-task", projectId, { agentRuntimeType: "pi", taskId: task.id });
      updateSessionMetadata("archived-scratch", { archived: true });
      updateSessionMetadata("archived-task", { archived: true });

      const response = await router.handle(
        makeRequest("GET", `/api/projects/${projectId}/sessions?archived=only`),
        state,
      );

      expect(response?.status).toBe(200);
      expect(await response!.json()).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "archived-task", taskTitle: "Open task" }),
        expect.objectContaining({ id: "archived-scratch", taskTitle: null }),
      ]));
    });
  });
});

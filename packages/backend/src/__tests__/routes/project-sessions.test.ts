import { describe, test, expect, beforeEach } from "bun:test";
import { useTestDb } from "../helpers/test-db.js";
import { makeRequest } from "../helpers/request.js";
import { createServerState } from "../helpers/server-state.js";
import { useTestRepo } from "../helpers/test-repo.js";
import { buildRouter } from "../../routes/index.js";
import { createProject } from "../../project-store.js";
import { createSession, updateActivityState } from "../../session-store.js";
import { persistMessages } from "../../messages-store.js";

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
      persistMessages("scratch-1", [{ role: "user", content: textContent("hello") }]);
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
      });
      expect(body[0]).toHaveProperty("createdAt");
      expect(body[0]).toHaveProperty("updatedAt");
      expect(body[0]).not.toHaveProperty("project_id");
      expect(body[0]).not.toHaveProperty("message_count");
      expect(body[0]).not.toHaveProperty("activity_state");
    });
  });
});

import { describe, test, expect, beforeEach } from "bun:test";
import { useTestDb } from "../helpers/test-db.js";
import { createTestState } from "../helpers/test-state.js";
import { useTestRepo } from "../helpers/test-repo.js";
import { buildRouter } from "../../routes/index.js";
import { createProject } from "../../project-store.js";
import { createSession, persistMessages } from "../../session-store.js";

function makeRequest(method: string, path: string): Request {
  return new Request(`http://localhost${path}`, { method });
}

describe("session routes (top-level)", () => {
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

  describe("GET /api/sessions/:sessionId", () => {
    test("returns session from memory with project_id", async () => {
      const sessionId = "lookup-memory";
      createSession(sessionId, projectId, {});

      state.sessions.set(sessionId, {
        session: {
          isStreaming: true,
          messages: [{ role: "user", content: "hi" }],
          model: { provider: "test", id: "test-model" },
          thinkingLevel: "none",
        } as any,
        id: sessionId,
        lastActivity: Date.now(),
      });

      const res = await router.handle(
        makeRequest("GET", `/api/sessions/${sessionId}`),
        state,
      );
      expect(res!.status).toBe(200);
      const body = await res!.json();
      expect(body.id).toBe(sessionId);
      expect(body.project_id).toBe(projectId);
      expect(body.state.isStreaming).toBe(true);
    });

    test("returns session from DB with project_id", async () => {
      const sessionId = "lookup-db";
      createSession(sessionId, projectId, {});
      persistMessages(sessionId, [
        { role: "user", content: "test" },
      ]);

      const res = await router.handle(
        makeRequest("GET", `/api/sessions/${sessionId}`),
        state,
      );
      expect(res!.status).toBe(200);
      const body = await res!.json();
      expect(body.id).toBe(sessionId);
      expect(body.project_id).toBe(projectId);
      expect(body.state.isStreaming).toBe(false);
      expect(body.messages).toBeArray();
    });

    test("returns 404 for nonexistent session", async () => {
      const res = await router.handle(
        makeRequest("GET", `/api/sessions/nonexistent`),
        state,
      );
      expect(res!.status).toBe(404);
    });
  });
});

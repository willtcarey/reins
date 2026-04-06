import { describe, test, expect, beforeEach } from "bun:test";
import { useTestDb } from "../helpers/test-db.js";
import { makeRequest } from "../helpers/request.js";
import { createServerState } from "../helpers/server-state.js";
import { useTestRepo } from "../helpers/test-repo.js";
import { buildRouter } from "../../routes/index.js";
import { createProject } from "../../project-store.js";
import { createSession, getSession } from "../../session-store.js";
import { createTestManagedSession } from "../helpers/test-pi.js";

describe("PUT /api/sessions/:sessionId/model", () => {
  let state: ReturnType<typeof createServerState>;
  let router: ReturnType<typeof buildRouter>;
  let projectId: number;

  useTestDb();
  const repo = useTestRepo();

  beforeEach(() => {
    state = createServerState();
    router = buildRouter();
    projectId = createProject("Test Project", repo.dir).id;
  });

  test("updates the session model and thinking level", async () => {
    const sessionId = "session-model-route";
    createSession(sessionId, projectId, { thinkingLevel: "medium" });
    state.sessions.set(sessionId, await createTestManagedSession(sessionId));

    const res = await router.handle(
      makeRequest("PUT", `/api/sessions/${sessionId}/model`, {
        provider: "anthropic",
        modelId: "claude-sonnet-4-20250514",
        thinkingLevel: "high",
      }),
      state,
    );

    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body.model_provider).toBe("anthropic");
    expect(body.model_id).toBe("claude-sonnet-4-20250514");
    expect(body.thinking_level).toBe("high");

    const updated = getSession(sessionId);
    expect(updated?.model_provider).toBe("anthropic");
    expect(updated?.model_id).toBe("claude-sonnet-4-20250514");
    expect(updated?.thinking_level).toBe("high");
  });

  test("returns 404 for a missing session", async () => {
    const res = await router.handle(
      makeRequest("PUT", "/api/sessions/missing/model", {
        provider: "anthropic",
        modelId: "claude-sonnet-4-20250514",
      }),
      state,
    );

    expect(res!.status).toBe(404);
  });

  test("returns 400 for an invalid body", async () => {
    const sessionId = "session-model-invalid";
    createSession(sessionId, projectId, {});

    const res = await router.handle(
      makeRequest("PUT", `/api/sessions/${sessionId}/model`, {
        provider: "anthropic",
      }),
      state,
    );

    expect(res!.status).toBe(400);
  });
});

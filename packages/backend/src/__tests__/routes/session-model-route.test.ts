import { describe, test, expect, beforeEach } from "bun:test";
import { useTestDb } from "../helpers/test-db.js";
import { makeRequest } from "../helpers/request.js";
import { createServerState } from "../helpers/server-state.js";
import { useTestRepo } from "../helpers/test-repo.js";
import { buildRouter } from "../../routes/index.js";
import { createProject } from "../../project-store.js";
import { createSession, getSession } from "../../session-store.js";
import { createTestManagedSession } from "../helpers/test-pi.js";
import { persistCanonicalMessages } from "../helpers/canonical-messages.js";

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
    createSession(sessionId, projectId, { agentRuntimeType: "pi", thinkingLevel: "medium" });
    state.sessions.set(sessionId, await createTestManagedSession(sessionId));

    const res = await router.handle(
      makeRequest("PUT", `/api/sessions/${sessionId}/model`, {
        provider: "anthropic",
        modelId: "claude-sonnet-4-5",
        thinkingLevel: "high",
      }),
      state,
    );

    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body.model_provider).toBe("anthropic");
    expect(body.model_id).toBe("claude-sonnet-4-5");
    expect(body.thinking_level).toBe("high");

    const updated = getSession(sessionId);
    expect(updated?.model_provider).toBe("anthropic");
    expect(updated?.model_id).toBe("claude-sonnet-4-5");
    expect(updated?.thinking_level).toBe("high");
  });

  test("rejects switching away from the canonical runtime", async () => {
    const sessionId = "session-runtime-switch-empty";
    createSession(sessionId, projectId, { agentRuntimeType: "pi", thinkingLevel: "medium" });
    state.sessions.set(sessionId, await createTestManagedSession(sessionId));

    const res = await router.handle(
      makeRequest("PUT", `/api/sessions/${sessionId}/model`, {
        runtimeType: "claude_agent_sdk",
        provider: "claude_agent_sdk",
        modelId: "claude-sonnet-4-5",
        thinkingLevel: "high",
      }),
      state,
    );

    expect(res!.status).toBe(400);
    expect((await res!.json()).error).toContain("Canonical sessions use the pi runtime");
    expect(getSession(sessionId)?.agent_runtime_type).toBe("pi");
  });

  test("updates a retired model on an inactive session before runtime open", async () => {
    const sessionId = "retired-model";
    createSession(sessionId, projectId, {
      agentRuntimeType: "pi", modelProvider: "anthropic", modelId: "retired-model-id", thinkingLevel: "high",
    });
    persistCanonicalMessages(sessionId, [{ role: "user", content: [{ type: "text", text: "history" }] }]);

    const res = await router.handle(
      makeRequest("PUT", `/api/sessions/${sessionId}/model`, {
        runtimeType: "pi", provider: "anthropic", modelId: "claude-sonnet-4-5", thinkingLevel: "high",
      }), state,
    );

    expect(res!.status).toBe(200);
    expect(state.sessions.has(sessionId)).toBe(false);
    expect(getSession(sessionId)).toMatchObject({ agent_runtime_type: "pi", model_provider: "anthropic", model_id: "claude-sonnet-4-5" });
  });

  test("rejects switching runtime after messages exist", async () => {
    const sessionId = "session-runtime-switch-nonempty";
    createSession(sessionId, projectId, { agentRuntimeType: "pi", thinkingLevel: "medium" });
    persistCanonicalMessages(sessionId, [{ role: "user", content: [{ type: "text", text: "hello" }] }]);

    const res = await router.handle(
      makeRequest("PUT", `/api/sessions/${sessionId}/model`, {
        runtimeType: "claude_agent_sdk",
        provider: "claude_agent_sdk",
        modelId: "claude-sonnet-4-5",
        thinkingLevel: "high",
      }),
      state,
    );

    expect(res!.status).toBe(400);
    const body = await res!.json();
    expect(body.error).toContain("Canonical sessions use the pi runtime");
  });

  test("returns 404 for a missing session", async () => {
    const res = await router.handle(
      makeRequest("PUT", "/api/sessions/missing/model", {
        provider: "anthropic",
        modelId: "claude-sonnet-4-5",
      }),
      state,
    );

    expect(res!.status).toBe(404);
  });

  test("returns 400 for an invalid body", async () => {
    const sessionId = "session-model-invalid";
    createSession(sessionId, projectId, { agentRuntimeType: "pi" });

    const res = await router.handle(
      makeRequest("PUT", `/api/sessions/${sessionId}/model`, {
        provider: "anthropic",
      }),
      state,
    );

    expect(res!.status).toBe(400);
  });
});

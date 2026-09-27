import { describe, test, expect, beforeEach } from "bun:test";
import { useTestDb } from "../helpers/test-db.js";
import { makeRequest } from "../helpers/request.js";
import { createServerState } from "../helpers/server-state.js";
import { useTestRepo } from "../helpers/test-repo.js";
import { buildRouter } from "../../routes/index.js";
import { createProject } from "../../project-store.js";
import { createSession, getSession } from "../session-fixture.js";
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

  test("updates the session model and thinking level, answers with the session view and tells every client", async () => {
    const sessionId = "session-model-route";
    createSession(sessionId, projectId, { agentRuntimeType: "pi", thinkingLevel: "medium" });
    const sent: unknown[] = [];
    state.clients.add({ ws: { send: (data: string) => { sent.push(JSON.parse(data)); return 0; } } });

    const res = await router.handle(
      makeRequest("PUT", `/api/sessions/${sessionId}/model`, {
        provider: "anthropic",
        modelId: "claude-sonnet-4-5",
        thinkingLevel: "high",
      }),
      state,
    );

    expect(res!.status).toBe(200);
    expect(await res!.json()).toMatchObject({
      id: sessionId,
      projectId,
      runtimeType: "pi",
      state: { model: { provider: "anthropic", id: "claude-sonnet-4-5" }, thinkingLevel: "high" },
    });
    expect(sent).toContainEqual({ type: "session_updated", sessionId, projectId });

    const updated = getSession(sessionId);
    expect(updated?.model_provider).toBe("anthropic");
    expect(updated?.model_id).toBe("claude-sonnet-4-5");
    expect(updated?.thinking_level).toBe("high");
  });

  test("rejects a model the catalog does not know", async () => {
    const sessionId = "session-model-unknown";
    createSession(sessionId, projectId, { agentRuntimeType: "pi", modelProvider: "anthropic", modelId: "claude-sonnet-4-5" });

    const res = await router.handle(
      makeRequest("PUT", `/api/sessions/${sessionId}/model`, { provider: "anthropic", modelId: "no-such-model" }),
      state,
    );

    expect(res!.status).toBe(400);
    expect((await res!.json()).error).toBe("Model 'no-such-model' not found for provider 'anthropic'");
    expect(getSession(sessionId)?.model_id).toBe("claude-sonnet-4-5");
  });

  test("rejects switching away from the canonical runtime", async () => {
    const sessionId = "session-runtime-switch-empty";
    createSession(sessionId, projectId, { agentRuntimeType: "pi", thinkingLevel: "medium" });

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

  test("updates a retired model on a session at rest", async () => {
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
    expect(await res!.json()).toEqual({ error: "Session not found" });
  });

  test("does not treat a model validation error containing not found as a missing session", async () => {
    const sessionId = "session-model-not-found";
    createSession(sessionId, projectId, { agentRuntimeType: "pi" });

    const res = await router.handle(
      makeRequest("PUT", `/api/sessions/${sessionId}/model`, {
        provider: "missing-provider",
        modelId: "missing-model",
      }),
      state,
    );

    expect(res!.status).toBe(400);
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

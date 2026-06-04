import { describe, test, expect, beforeEach } from "bun:test";
import { useTestDb } from "../helpers/test-db.js";
import { makeRequest } from "../helpers/request.js";
import { createServerState } from "../helpers/server-state.js";
import { useTestRepo } from "../helpers/test-repo.js";
import { buildRouter } from "../../routes/index.js";
import { createProject } from "../../project-store.js";
import { createSession } from "../../session-store.js";
import { persistMessages } from "../../messages-store.js";
import { createTestManagedSession } from "../helpers/test-pi.js";

function textContent(text: string) {
  return [{ type: "text" as const, text }];
}

describe("session routes (top-level)", () => {
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

  describe("GET /api/sessions/:sessionId", () => {
    test("returns session from memory with project_id", async () => {
      const sessionId = "lookup-memory";
      createSession(sessionId, projectId, { agentRuntimeType: "pi",});

      state.sessions.set(sessionId, await createTestManagedSession(sessionId));

      const res = await router.handle(
        makeRequest("GET", `/api/sessions/${sessionId}`),
        state,
      );
      expect(res!.status).toBe(200);
      const body = await res!.json();
      expect(body.id).toBe(sessionId);
      expect(body.project_id).toBe(projectId);
      expect(body.state.isStreaming).toBe(false);
    });

    test("uses DB model metadata and overlays in-memory streaming state", async () => {
      const sessionId = "lookup-memory-db-first";
      createSession(sessionId, projectId, {
        agentRuntimeType: "pi",
        modelProvider: "openai",
        modelId: "gpt-5",
        thinkingLevel: "minimal",
      });

      state.sessions.set(sessionId, await createTestManagedSession(sessionId, { isStreaming: true }));

      const res = await router.handle(
        makeRequest("GET", `/api/sessions/${sessionId}`),
        state,
      );
      expect(res!.status).toBe(200);
      const body = await res!.json();
      expect(body.state.model).toEqual({ provider: "openai", id: "gpt-5" });
      expect(body.state.thinkingLevel).toBe("minimal");
      expect(body.state.isStreaming).toBe(true);
    });

    test("returns metadata-only session from DB with project_id", async () => {
      const sessionId = "lookup-db";
      createSession(sessionId, projectId, { agentRuntimeType: "pi",});
      persistMessages(sessionId, [
        { role: "user", content: textContent("test") },
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
      expect(body.state.messageCount).toBe(1);
      expect(body).not.toHaveProperty("messages");
    });

    test("returns 404 for nonexistent session", async () => {
      const res = await router.handle(
        makeRequest("GET", `/api/sessions/nonexistent`),
        state,
      );
      expect(res!.status).toBe(404);
    });
  });

  describe("GET /api/sessions/:sessionId/messages", () => {
    test("returns persisted messages for an existing session", async () => {
      const sessionId = "messages-existing";
      createSession(sessionId, projectId, { agentRuntimeType: "pi",});
      persistMessages(sessionId, [
        { role: "user", content: textContent("hello"), timestamp: 1000 },
        {
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
          timestamp: 2000,
        },
      ]);

      const res = await router.handle(
        makeRequest("GET", `/api/sessions/${sessionId}/messages`),
        state,
      );

      expect(res!.status).toBe(200);
      expect(await res!.json()).toEqual([
        { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1000 },
        {
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
          timestamp: 2000,
        },
      ]);
    });

    test("returns [] for an existing session with no messages", async () => {
      const sessionId = "messages-empty";
      createSession(sessionId, projectId, { agentRuntimeType: "pi",});

      const res = await router.handle(
        makeRequest("GET", `/api/sessions/${sessionId}/messages`),
        state,
      );

      expect(res!.status).toBe(200);
      expect(await res!.json()).toEqual([]);
    });

    test("returns persisted messages for non-pi sessions", async () => {
      const sessionId = "messages-runtime";
      createSession(sessionId, projectId, { agentRuntimeType: "claude_agent_sdk" });
      persistMessages(sessionId, [
        { role: "assistant", content: [{ type: "text", text: "from db" }] },
      ]);

      state.sessions.set(sessionId, {
        id: sessionId,
        lastActivity: Date.now(),
        runtime: {
          prompt: async () => {},
          steer: async () => {},
          abort: async () => {},
          setModel: async () => {},
          subscribe: () => () => {},
          getMessages: async () => [{ role: "assistant", content: [{ type: "text", text: "from runtime" }] }],
          isStreaming: () => false,
          close: async () => {},
        },
      });

      const res = await router.handle(
        makeRequest("GET", `/api/sessions/${sessionId}/messages`),
        state,
      );

      expect(res!.status).toBe(200);
      expect(await res!.json()).toEqual([
        { role: "assistant", content: [{ type: "text", text: "from db" }] },
      ]);
    });

    test("returns 404 for nonexistent session", async () => {
      const res = await router.handle(
        makeRequest("GET", `/api/sessions/nonexistent/messages`),
        state,
      );

      expect(res!.status).toBe(404);
    });
  });
});

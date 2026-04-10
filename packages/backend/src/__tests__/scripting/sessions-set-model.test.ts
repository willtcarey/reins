/**
 * Tests for sessions.setModel scripting API function.
 */

import { describe, test, expect, beforeEach, mock } from "bun:test";
import { useTestDb } from "../helpers/test-db.js";
import { createServerState } from "../helpers/server-state.js";
import { createTestManagedSession } from "../helpers/test-pi.js";
import { createProject, type Project } from "../../project-store.js";
import { createSession, getSession } from "../../session-store.js";
import { SESSION_FUNCTIONS, sessionsSetModelFunction } from "../../scripting/sessions.js";
import type { ApiContext } from "../../scripting/api-registry.js";
import type { ServerMessage } from "../../models/broadcast.js";
import type { ManagedSession } from "../../state.js";
import { getPiSession } from "../../runtimes/pi/runtime.js";

async function createMockManagedSession(sessionId: string): Promise<ManagedSession> {
  const managed = await createTestManagedSession(sessionId);
  const session = getPiSession(managed.runtime);
  session.setModel = mock<typeof session.setModel>(async () => {});
  session.setThinkingLevel = mock<typeof session.setThinkingLevel>(() => {});
  return managed;
}

describe("sessions.setModel", () => {
  useTestDb();

  let project: Project;
  let broadcastMessages: ServerMessage[];
  let broadcast: ApiContext["broadcast"];
  let sessions: Map<string, ManagedSession>;

  beforeEach(() => {
    // Create test project — needs a valid path for the DB but we don't use git
    project = createProject("Test Project", "/tmp/test-project", "main");
    broadcastMessages = [];
    broadcast = (msg: ServerMessage) => broadcastMessages.push(msg);
    sessions = new Map();
    createServerState({ sessions });
  });

  function makeCtx(overrides?: Partial<ApiContext>): ApiContext {
    return {
      projectId: project.id,
      sessionId: "ctx-session",
      taskId: null,
      broadcast,
      sessions,
      ...overrides,
    };
  }

  test("updates DB row with new model", async () => {
    // Create session in DB
    createSession("sess-1", project.id, {
       agentRuntimeType: "pi",modelProvider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
    });

    // Create mock managed session
    const managed = await createMockManagedSession("sess-1");
    sessions.set("sess-1", managed);

    const ctx = makeCtx();
    const result = await sessionsSetModelFunction.execute(
      { sessionId: "sess-1", provider: "anthropic", modelId: "claude-sonnet-4-20250514" },
      ctx,
    );

    // Check DB was updated
    const updated = getSession("sess-1");
    expect(updated!.model_provider).toBe("anthropic");
    expect(updated!.model_id).toBe("claude-sonnet-4-20250514");

    // Check return value matches DB
    expect(result.model_provider).toBe("anthropic");
    expect(result.model_id).toBe("claude-sonnet-4-20250514");
  });

  test("calls pi SDK setModel", async () => {
    createSession("sess-2", project.id, { agentRuntimeType: "pi" });
    const managed = await createMockManagedSession("sess-2");
    sessions.set("sess-2", managed);

    const ctx = makeCtx();
    await sessionsSetModelFunction.execute(
      { sessionId: "sess-2", provider: "anthropic", modelId: "claude-sonnet-4-20250514" },
      ctx,
    );

    expect(getPiSession(managed.runtime).setModel).toHaveBeenCalledTimes(1);
  });

  test("sets thinking level when provided", async () => {
    createSession("sess-3", project.id, { agentRuntimeType: "pi" });
    const managed = await createMockManagedSession("sess-3");
    sessions.set("sess-3", managed);

    const ctx = makeCtx();
    await sessionsSetModelFunction.execute(
      { sessionId: "sess-3", provider: "anthropic", modelId: "claude-sonnet-4-20250514", thinkingLevel: "high" },
      ctx,
    );

    expect(getPiSession(managed.runtime).setThinkingLevel).toHaveBeenCalledTimes(1);
    expect(getPiSession(managed.runtime).setThinkingLevel).toHaveBeenCalledWith("high");

    const updated = getSession("sess-3");
    expect(updated!.thinking_level).toBe("high");
  });

  test("thinkingLevel is optional — uses session's current level", async () => {
    createSession("sess-4", project.id, {  agentRuntimeType: "pi",thinkingLevel: "medium" });
    const managed = await createMockManagedSession("sess-4");
    sessions.set("sess-4", managed);

    const ctx = makeCtx();
    await sessionsSetModelFunction.execute(
      { sessionId: "sess-4", provider: "anthropic", modelId: "claude-sonnet-4-20250514" },
      ctx,
    );

    // setThinkingLevel should NOT be called since no level was provided
    expect(getPiSession(managed.runtime).setThinkingLevel).not.toHaveBeenCalled();

    // DB should keep the session's current thinking level
    const updated = getSession("sess-4");
    expect(updated!.thinking_level).toBe("medium");
  });

  test("broadcasts session_updated event when a session model changes", async () => {
    createSession("sess-5", project.id, { agentRuntimeType: "pi" });
    const managed = await createMockManagedSession("sess-5");
    sessions.set("sess-5", managed);

    const ctx = makeCtx();
    await sessionsSetModelFunction.execute(
      { sessionId: "sess-5", provider: "anthropic", modelId: "claude-sonnet-4-20250514", thinkingLevel: "high" },
      ctx,
    );

    expect(broadcastMessages.length).toBe(1);
    const msg = broadcastMessages[0];
    expect(msg.type).toBe("session_updated");
    if (msg.type === "session_updated") {
      expect(msg.sessionId).toBe("sess-5");
      expect(msg.projectId).toBe(project.id);
    }
  });

  test("updates DB and still broadcasts when session is not open in memory", async () => {
    createSession("sess-5b", project.id, {  agentRuntimeType: "pi",thinkingLevel: "low" });

    const ctx = makeCtx();
    const result = await sessionsSetModelFunction.execute(
      { sessionId: "sess-5b", provider: "anthropic", modelId: "claude-sonnet-4-20250514" },
      ctx,
    );

    const updated = getSession("sess-5b");
    expect(updated!.model_provider).toBe("anthropic");
    expect(updated!.model_id).toBe("claude-sonnet-4-20250514");
    expect(updated!.thinking_level).toBe("low");
    expect(result.model_provider).toBe("anthropic");
    expect(result.model_id).toBe("claude-sonnet-4-20250514");
    expect(result.thinking_level).toBe("low");
    expect(broadcastMessages).toEqual([
      {
        type: "session_updated",
        sessionId: "sess-5b",
        projectId: project.id,
      },
    ]);
  });

  test("throws for unknown provider", async () => {
    createSession("sess-6", project.id, { agentRuntimeType: "pi" });
    const managed = await createMockManagedSession("sess-6");
    sessions.set("sess-6", managed);

    const ctx = makeCtx();
    await expect(
      sessionsSetModelFunction.execute(
        { sessionId: "sess-6", provider: "nonexistent", modelId: "some-model" },
        ctx,
      ),
    ).rejects.toThrow(/Unknown provider/);
  });

  test("throws for invalid model ID", async () => {
    createSession("sess-7", project.id, { agentRuntimeType: "pi" });
    const managed = await createMockManagedSession("sess-7");
    sessions.set("sess-7", managed);

    const ctx = makeCtx();
    await expect(
      sessionsSetModelFunction.execute(
        { sessionId: "sess-7", provider: "anthropic", modelId: "nonexistent-model" },
        ctx,
      ),
    ).rejects.toThrow(/not found for provider/);
  });

  test("throws when session not in this project", async () => {
    // Create session in a different project
    const otherProject = createProject("Other Project", "/tmp/other-project", "main");
    createSession("sess-8", otherProject.id, { agentRuntimeType: "pi" });
    const managed = await createMockManagedSession("sess-8");
    sessions.set("sess-8", managed);

    const ctx = makeCtx(); // ctx.projectId = project.id (different from otherProject)
    await expect(
      sessionsSetModelFunction.execute(
        { sessionId: "sess-8", provider: "anthropic", modelId: "claude-sonnet-4-20250514" },
        ctx,
      ),
    ).rejects.toThrow(/not found/);
  });

  test("updates inactive sessions without calling the pi SDK", async () => {
    createSession("sess-9", project.id, {  agentRuntimeType: "pi",thinkingLevel: "medium" });
    // Don't add to sessions map

    const ctx = makeCtx();
    await expect(
      sessionsSetModelFunction.execute(
        { sessionId: "sess-9", provider: "anthropic", modelId: "claude-sonnet-4-20250514" },
        ctx,
      ),
    ).resolves.toBeDefined();

    const updated = getSession("sess-9");
    expect(updated!.model_provider).toBe("anthropic");
    expect(updated!.model_id).toBe("claude-sonnet-4-20250514");
    expect(updated!.thinking_level).toBe("medium");
    expect(broadcastMessages).toEqual([
      {
        type: "session_updated",
        sessionId: "sess-9",
        projectId: project.id,
      },
    ]);
  });

  test("throws for invalid thinking level", async () => {
    createSession("sess-10", project.id, { agentRuntimeType: "pi" });
    const managed = await createMockManagedSession("sess-10");
    sessions.set("sess-10", managed);

    const rawSetModelFunction = SESSION_FUNCTIONS.find((fn) => fn.name === "sessions.setModel");
    expect(rawSetModelFunction).toBeDefined();

    const ctx = makeCtx();
    await expect(
      rawSetModelFunction!.execute(
        { sessionId: "sess-10", provider: "anthropic", modelId: "claude-sonnet-4-20250514", thinkingLevel: "invalid-level" },
        ctx,
      ),
    ).rejects.toThrow(/Invalid thinking level/);
  });
});

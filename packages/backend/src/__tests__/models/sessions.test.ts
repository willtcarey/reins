import { describe, test, expect, beforeEach, mock } from "bun:test";
import { useTestDb } from "../helpers/test-db.js";
import { createTestManagedSession } from "../helpers/test-pi.js";
import { createProject, type Project } from "../../project-store.js";
import { createSession, getSession, persistMessages } from "../../session-store.js";
import { Sessions } from "../../models/sessions.js";
import type { Broadcast, ServerMessage } from "../../models/broadcast.js";
import type { ManagedSession } from "../../state.js";
import { getPiSession } from "../../runtimes/pi/runtime.js";
import { clearRuntimeAdapters, registerRuntimeAdapter } from "../../runtimes/registry.js";
import { registerBuiltinRuntimeAdapters } from "../../runtimes/register-builtins.js";

async function createMockManagedSession(sessionId: string): Promise<ManagedSession> {
  const managed = await createTestManagedSession(sessionId);
  const session = getPiSession(managed.runtime);
  session.setModel = mock<typeof session.setModel>(async () => {});
  session.setThinkingLevel = mock<typeof session.setThinkingLevel>(() => {});
  return managed;
}

describe("Sessions.setModel", () => {
  useTestDb();

  let project: Project;
  let broadcastSpy: ReturnType<typeof mock<(msg: ServerMessage) => void>>;
  let broadcast: Broadcast;
  let sessions: Map<string, ManagedSession>;
  let model: Sessions;

  beforeEach(() => {
    clearRuntimeAdapters();
    registerBuiltinRuntimeAdapters();

    project = createProject("Test Project", "/tmp/test-project", "main");
    broadcastSpy = mock<(msg: ServerMessage) => void>();
    broadcast = broadcastSpy;
    sessions = new Map();
    model = new Sessions(sessions, broadcast);
  });

  test("updates an open session live, persists metadata, and broadcasts a session update", async () => {
    createSession("sess-1", project.id, {  agentRuntimeType: "pi",thinkingLevel: "medium" });
    const managed = await createMockManagedSession("sess-1");
    sessions.set("sess-1", managed);

    const result = await model.setModel({
      sessionId: "sess-1",
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      thinkingLevel: "high",
    });

    const session = getPiSession(managed.runtime);
    expect(session.setModel).toHaveBeenCalledTimes(1);
    expect(session.setThinkingLevel).toHaveBeenCalledWith("high");

    const updated = getSession("sess-1");
    expect(updated!.model_provider).toBe("anthropic");
    expect(updated!.model_id).toBe("claude-sonnet-4-20250514");
    expect(updated!.thinking_level).toBe("high");
    expect(result.model_provider).toBe("anthropic");
    expect(result.model_id).toBe("claude-sonnet-4-20250514");
    expect(result.thinking_level).toBe("high");

    expect(broadcastSpy).toHaveBeenCalledWith({
      type: "session_updated",
      sessionId: "sess-1",
      projectId: project.id,
    });
  });

  test("updates an inactive session in the DB and broadcasts a session update", async () => {
    createSession("sess-2", project.id, {  agentRuntimeType: "pi",thinkingLevel: "low" });

    const result = await model.setModel({
      sessionId: "sess-2",
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
    });

    const updated = getSession("sess-2");
    expect(updated!.model_provider).toBe("anthropic");
    expect(updated!.model_id).toBe("claude-sonnet-4-20250514");
    expect(updated!.thinking_level).toBe("low");
    expect(result.thinking_level).toBe("low");
    expect(broadcastSpy).toHaveBeenCalledWith({
      type: "session_updated",
      sessionId: "sess-2",
      projectId: project.id,
    });
  });

  test("throws when the session does not belong to the project", async () => {
    const otherProject = createProject("Other Project", "/tmp/other-project", "main");
    createSession("sess-3", otherProject.id, { agentRuntimeType: "pi" });

    await expect(
      model.setModel({
        sessionId: "sess-3",
        projectId: project.id,
        provider: "anthropic",
        modelId: "claude-sonnet-4-20250514",
      }),
    ).rejects.toThrow(/not found/);
  });

  test("throws for invalid thinking level", async () => {
    createSession("sess-4", project.id, { agentRuntimeType: "pi" });

    await expect(
      model.setModel({
        sessionId: "sess-4",
        provider: "anthropic",
        modelId: "claude-sonnet-4-20250514",
        thinkingLevel: "invalid-level",
      }),
    ).rejects.toThrow(/Invalid thinking level/);
  });

  test("updates live model via AgentRuntime.setModel for non-pi runtimes", async () => {
    const setModel = mock(async () => {});

    registerRuntimeAdapter({
      runtimeType: "test_runtime",
      listModels: async () => [{
        provider: "anthropic",
        isAvailable: true,
        availabilitySource: "env",
        availabilitySources: ["env"],
        models: [{
          id: "claude-sonnet-4-20250514",
          name: "Claude Sonnet 4",
          reasoning: true,
          contextWindow: 200_000,
          maxTokens: 8_192,
        }],
      }],
      ask: async () => "",
      createRuntime: async () => {
        throw new Error("not used in this test");
      },
    });

    createSession("sess-runtime", project.id, { agentRuntimeType: "test_runtime", thinkingLevel: "medium" });

    sessions.set("sess-runtime", {
      id: "sess-runtime",
      lastActivity: Date.now(),
      runtime: {
        prompt: async () => {},
        steer: async () => {},
        abort: async () => {},
        setModel,
        subscribe: () => () => {},
        getMessages: async () => [],
        isStreaming: () => false,
        close: async () => {},
      },
    });

    const result = await model.setModel({
      sessionId: "sess-runtime",
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      thinkingLevel: "high",
    });

    expect(setModel).toHaveBeenCalledWith({
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      thinkingLevel: "high",
    });

    expect(result.model_provider).toBe("anthropic");
    expect(result.model_id).toBe("claude-sonnet-4-20250514");
    expect(result.thinking_level).toBe("high");
  });

  test("getMessages strips leading <skill> blocks from user messages", () => {
    createSession("sess-skills", project.id, { agentRuntimeType: "pi" });
    const skillBlock = `<skill name="dip" path="/tmp/dip/SKILL.md">\ndip body\n</skill>`;
    persistMessages("sess-skills", [
      {
        role: "user",
        content: [{ type: "text", text: `${skillBlock}\n\n/dip start` }],
      },
      {
        role: "user",
        content: "just text",
      },
      {
        role: "assistant",
        content: [{ type: "text", text: `${skillBlock}\n\nkeep me` }],
      },
    ]);

    const messages = model.getMessages("sess-skills")!;
    expect(messages).toHaveLength(3);

    expect((messages[0]!.content as Array<{ text: string }>)[0]!.text).toBe("/dip start");
    expect(messages[1]!.content).toBe("just text");
    // Assistant messages are not stripped.
    expect((messages[2]!.content as Array<{ text: string }>)[0]!.text).toBe(`${skillBlock}\n\nkeep me`);
  });

  test("rejects unknown providers", async () => {
    createSession("sess-5", project.id, { agentRuntimeType: "pi", thinkingLevel: "low" });

    await expect(
      model.setModel({
        sessionId: "sess-5",
        provider: "claude-agent-sdk",
        modelId: "claude-opus-4-5",
      }),
    ).rejects.toThrow(/Unknown provider/);
  });
});

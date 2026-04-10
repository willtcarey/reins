import { describe, test, expect, beforeEach, mock } from "bun:test";
import { useTestDb } from "../helpers/test-db.js";
import { createTestManagedSession } from "../helpers/test-pi.js";
import { createProject, type Project } from "../../project-store.js";
import { createSession, getSession } from "../../session-store.js";
import { ProjectSessions } from "../../models/sessions.js";
import type { Broadcast, ServerMessage } from "../../models/broadcast.js";
import type { ManagedSession } from "../../state.js";
import { getPiSession } from "../../runtimes/pi/runtime.js";

async function createMockManagedSession(sessionId: string): Promise<ManagedSession> {
  const managed = await createTestManagedSession(sessionId);
  const session = getPiSession(managed.runtime);
  session.setModel = mock<typeof session.setModel>(async () => {});
  session.setThinkingLevel = mock<typeof session.setThinkingLevel>(() => {});
  return managed;
}

describe("ProjectSessions.setModel", () => {
  useTestDb();

  let project: Project;
  let broadcastSpy: ReturnType<typeof mock<(msg: ServerMessage) => void>>;
  let broadcast: Broadcast;
  let sessions: Map<string, ManagedSession>;
  let model: ProjectSessions;

  beforeEach(() => {
    project = createProject("Test Project", "/tmp/test-project", "main");
    broadcastSpy = mock<(msg: ServerMessage) => void>();
    broadcast = broadcastSpy;
    sessions = new Map();
    model = new ProjectSessions(project.id, sessions, broadcast);
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

  test("accepts extension-registered providers", async () => {
    createSession("sess-5", project.id, {  agentRuntimeType: "pi",thinkingLevel: "low" });

    const result = await model.setModel({
      sessionId: "sess-5",
      provider: "claude-agent-sdk",
      modelId: "claude-opus-4-5",
    });

    const updated = getSession("sess-5");
    expect(updated!.model_provider).toBe("claude-agent-sdk");
    expect(updated!.model_id).toBe("claude-opus-4-5");
    expect(result.model_provider).toBe("claude-agent-sdk");
    expect(result.model_id).toBe("claude-opus-4-5");
  });
});

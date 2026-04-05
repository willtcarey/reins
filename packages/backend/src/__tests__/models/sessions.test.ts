/* eslint-disable @typescript-eslint/consistent-type-assertions -- mock session & execute() returns unknown */

import { describe, test, expect, beforeEach, mock } from "bun:test";
import { useTestDb } from "../helpers/test-db.js";
import { createProject, type Project } from "../../project-store.js";
import { createSession, getSession } from "../../session-store.js";
import { ProjectSessions } from "../../models/sessions.js";
import type { Broadcast, ServerMessage } from "../../models/broadcast.js";
import type { ManagedSession } from "../../state.js";

function createMockManagedSession(sessionId: string): ManagedSession {
  return {
    id: sessionId,
    lastActivity: Date.now(),
    session: {
      setModel: mock(() => Promise.resolve()),
      setThinkingLevel: mock(() => {}),
      thinkingLevel: "medium",
      model: { provider: "anthropic", id: "claude-sonnet-4-20250514" },
    } as any,
  };
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

  test("updates an open session live, persists metadata, and broadcasts the change", async () => {
    createSession("sess-1", project.id, { thinkingLevel: "medium" });
    const managed = createMockManagedSession("sess-1");
    sessions.set("sess-1", managed);

    const result = await model.setModel({
      sessionId: "sess-1",
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      thinkingLevel: "high",
    });

    expect(managed.session.setModel).toHaveBeenCalledTimes(1);
    expect(managed.session.setThinkingLevel).toHaveBeenCalledWith("high");

    const updated = getSession("sess-1");
    expect(updated!.model_provider).toBe("anthropic");
    expect(updated!.model_id).toBe("claude-sonnet-4-20250514");
    expect(updated!.thinking_level).toBe("high");
    expect(result.model_provider).toBe("anthropic");
    expect(result.model_id).toBe("claude-sonnet-4-20250514");
    expect(result.thinking_level).toBe("high");

    expect(broadcastSpy).toHaveBeenCalledWith({
      type: "session_model_changed",
      sessionId: "sess-1",
      projectId: project.id,
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      thinkingLevel: "high",
    });
  });

  test("updates an inactive session in the DB without live SDK calls or broadcast", async () => {
    createSession("sess-2", project.id, { thinkingLevel: "low" });

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
    expect(broadcastSpy).not.toHaveBeenCalled();
  });

  test("throws when the session does not belong to the project", async () => {
    const otherProject = createProject("Other Project", "/tmp/other-project", "main");
    createSession("sess-3", otherProject.id);

    await expect(
      model.setModel({
        sessionId: "sess-3",
        provider: "anthropic",
        modelId: "claude-sonnet-4-20250514",
      }),
    ).rejects.toThrow(/not found/);
  });

  test("throws for invalid thinking level", async () => {
    createSession("sess-4", project.id);

    await expect(
      model.setModel({
        sessionId: "sess-4",
        provider: "anthropic",
        modelId: "claude-sonnet-4-20250514",
        thinkingLevel: "invalid-level",
      }),
    ).rejects.toThrow(/Invalid thinking level/);
  });
});

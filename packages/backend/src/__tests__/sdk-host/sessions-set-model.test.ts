/**
 * Tests for sessions.setModel scripting API function.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { useTestDb } from "../helpers/test-db.js";
import { getDb } from "../../app-globals.js";
import { type Project } from "../../project-store.js";
import { createProject } from "../project-fixture.js";
import { createSession, getSession } from "../session-fixture.js";
import { Value } from "@sinclair/typebox/value";
import { buildApiObject } from "../../sdk-host/scripts.js";
import { SessionSchema } from "../../sdk-host/sessions.js";
import type { ServerMessage } from "../../models/broadcast.js";
import { Models } from "../../models/models.js";
import { createAppState } from "../helpers/app-state.js";
import { PiStorageAdapter } from "../../pi-storage.js";
import { storedLaneModel } from "../../session-runtime/lane.js";
import { scriptContext } from "../helpers/script-context.js";

/** Pi's main lane's model selection, as stored. */
const lane = (sessionId: string) => storedLaneModel(new PiStorageAdapter(getDb(), sessionId));

describe("sessions.setModel", () => {
  useTestDb();

  let project: Project;
  let broadcastMessages: ServerMessage[];

  beforeEach(() => {
    // Create test project — needs a valid path for the DB but we don't use git
    project = createProject("Test Project", "/tmp/test-project", "main");
    broadcastMessages = [];
  });

  function contextState() {
    const state = createAppState({ clients: new Set([{ ws: { send: data => { broadcastMessages.push(JSON.parse(data)); return 0; } } }]) });
    const models = new Models(state);
    return { state, models };
  }

  /** `api.sessions.setModel` of a script of a session of the project, its result checked as a session. */
  function makeCtx() {
    const { state } = contextState();
    const api = buildApiObject(scriptContext(state, { sessionId: "ctx-session", projectId: project.id }));
    return async (...args: unknown[]) => Value.Parse(SessionSchema, await api.sessions.setModel(...args));
  }

  test("updates DB row with new model", async () => {
    // Create session in DB
    createSession("sess-1", project.id, {
       agentRuntimeType: "pi",modelProvider: "anthropic",
      modelId: "claude-sonnet-4-5",
    });

    const ctx = makeCtx();
    const result = await ctx("sess-1", "anthropic", "claude-sonnet-4-5");

    // Check DB was updated
    const updated = getSession("sess-1");
    expect(updated!.model_provider).toBe("anthropic");
    expect(updated!.model_id).toBe("claude-sonnet-4-5");

    // Check return value matches DB
    expect(result.model).toMatchObject({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
  });

  test("sets the model through the session's runtime, on Pi's lane", async () => {
    createSession("sess-2", project.id, { agentRuntimeType: "pi" });

    const ctx = makeCtx();
    await ctx("sess-2", "anthropic", "claude-sonnet-4-5");

    expect(await lane("sess-2")).toMatchObject({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
  });

  test("sets thinking level when provided", async () => {
    createSession("sess-3", project.id, { agentRuntimeType: "pi" });

    const ctx = makeCtx();
    await ctx("sess-3", "anthropic", "claude-sonnet-4-5", "high");

    expect(await lane("sess-3")).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-5", thinkingLevel: "high" });

    const updated = getSession("sess-3");
    expect(updated!.thinking_level).toBe("high");
  });

  test("thinkingLevel is optional — uses session's current level", async () => {
    createSession("sess-4", project.id, { agentRuntimeType: "pi", modelProvider: "anthropic", modelId: "claude-haiku-4-5", thinkingLevel: "medium" });

    const ctx = makeCtx();
    await ctx("sess-4", "anthropic", "claude-sonnet-4-5");

    // No level given: Pi's lane keeps its level (seeded from the row's).
    expect(await lane("sess-4")).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-5", thinkingLevel: "medium" });

    // DB should keep the session's current thinking level
    const updated = getSession("sess-4");
    expect(updated!.thinking_level).toBe("medium");
  });

  test("broadcasts session_updated event when a session model changes", async () => {
    createSession("sess-5", project.id, { agentRuntimeType: "pi" });

    const ctx = makeCtx();
    await ctx("sess-5", "anthropic", "claude-sonnet-4-5", "high");

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
    const result = await ctx("sess-5b", "anthropic", "claude-sonnet-4-5");

    const updated = getSession("sess-5b");
    expect(updated!.model_provider).toBe("anthropic");
    expect(updated!.model_id).toBe("claude-sonnet-4-5");
    expect(updated!.thinking_level).toBe("low");
    expect(result.model).toMatchObject({ provider: "anthropic", modelId: "claude-sonnet-4-5", thinkingLevel: "low" });
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

    const ctx = makeCtx();
    await expect(
      ctx("sess-6", "nonexistent", "some-model"),
    ).rejects.toThrow("Model 'some-model' not found for provider 'nonexistent'");
  });

  test("throws for invalid model ID", async () => {
    createSession("sess-7", project.id, { agentRuntimeType: "pi" });

    const ctx = makeCtx();
    await expect(
      ctx("sess-7", "anthropic", "nonexistent-model"),
    ).rejects.toThrow(/not found for provider/);
  });

  test("sets the model of a session of another project", async () => {
    const otherProject = createProject("Other Project", "/tmp/other-project", "main");
    createSession("sess-8", otherProject.id, { agentRuntimeType: "pi" });

    const result = await makeCtx()("sess-8", "anthropic", "claude-sonnet-4-5");

    expect(result).toMatchObject({ id: "sess-8", model: { modelId: "claude-sonnet-4-5" } });
  });

  test("updates inactive sessions without calling the pi SDK", async () => {
    createSession("sess-9", project.id, {  agentRuntimeType: "pi",thinkingLevel: "medium" });
    // Don't add to sessions map

    const ctx = makeCtx();
    await expect(
      ctx("sess-9", "anthropic", "claude-sonnet-4-5"),
    ).resolves.toBeDefined();

    const updated = getSession("sess-9");
    expect(updated!.model_provider).toBe("anthropic");
    expect(updated!.model_id).toBe("claude-sonnet-4-5");
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

    const ctx = makeCtx();
    await expect(ctx("sess-10", "anthropic", "claude-sonnet-4-5", "invalid-level")).rejects.toThrow("api.sessions.setModel: thinkingLevel");
  });
});

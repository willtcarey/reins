import { nodeRuntimesForTesting } from "@reins/node/node";
import { describe, test, expect } from "bun:test";
import { useTestDb } from "./helpers/test-db.js";
import { useTestRepo } from "./helpers/test-repo.js";
import { createServerState } from "./helpers/server-state.js";
import { createProject } from "../project-store.js";
import { getSession } from "./session-fixture.js";
import { setSetting, deleteSetting } from "../settings-store.js";
import { createSession as createNewSession } from "../runtimes/create-session.js";
import { sessionTarget } from "../runtimes/node-source.js";
import { loopbackNodeFor } from "./helpers/loopback-node.js";
import { createSession } from "./session-fixture.js";
import type { ServerState } from "../state.js";

/** Test seam: the node opens its runtime as an opening command for the session would; tests observe what
 * that open does. */
const openOnNode = (state: ServerState, sessionId: string) => {
  const { nodeId: _nodeId, ...target } = sessionTarget(sessionId);
  return nodeRuntimesForTesting(loopbackNodeFor(state)).open(sessionId, target);
};

describe("canonical session model selection", () => {
  useTestDb();
  const repo = useTestRepo();

  test("requires an explicit configured model for a new session", async () => {
    deleteSetting("default_model");
    const state = createServerState(undefined, { loopbackNode: true });
    const project = createProject("Test Project", repo.dir, "main");
    const created = createNewSession(state, project.id);
    expect(sessionTarget(created.id).lane).toEqual({ model: null, thinkingLevel: null });
    await expect(openOnNode(state, created.id)).rejects.toThrow("requires an explicit model");
  });

  test("rejects a Claude-runtime default instead of routing it through Pi", async () => {
    setSetting("default_model", {
      provider: "claude_agent_sdk",
      modelId: "claude-sonnet-4-6",
      runtimeType: "claude_agent_sdk",
      thinkingLevel: "high",
    });
    const state = createServerState(undefined, { loopbackNode: true });
    const project = createProject("Test Project", repo.dir, "main");
    expect(() => createNewSession(state, project.id)).toThrow("Configured default_model uses unavailable runtime 'claude_agent_sdk'");
    // Nor does it seed the lane of a session with no model of its own.
    createSession("unset", project.id, { agentRuntimeType: "pi" });
    expect(() => sessionTarget("unset")).toThrow("Configured default_model uses unavailable runtime 'claude_agent_sdk'");
  });

  test("applies configured model and thinking to a new session", async () => {
    setSetting("default_model", { provider: "anthropic", modelId: "claude-sonnet-4-5", runtimeType: "pi", thinkingLevel: "high" });
    const state = createServerState(undefined, { loopbackNode: true });
    const project = createProject("Test Project", repo.dir, "main");
    const managed = createNewSession(state, project.id);
    const opened = await openOnNode(state, managed.id);
    expect(opened.getSessionMetadata()).toEqual({ model: { provider: "anthropic", modelId: "claude-sonnet-4-5" }, thinkingLevel: "high" });
    expect(getSession(managed.id)).toMatchObject({ agent_runtime_type: "pi", model_provider: "anthropic", model_id: "claude-sonnet-4-5", thinking_level: "high" });
    await nodeRuntimesForTesting(loopbackNodeFor(state)).close(managed.id);
  });

  test("reports an invalid configured model without fallback", async () => {
    setSetting("default_model", { provider: "anthropic", modelId: "does-not-exist", runtimeType: "pi", thinkingLevel: "high" });
    const state = createServerState(undefined, { loopbackNode: true });
    const project = createProject("Test Project", repo.dir, "main");
    const created = createNewSession(state, project.id);
    // The node refuses to open the session: Pi cannot create its lane with a model it does not know.
    await expect(openOnNode(state, created.id)).rejects.toThrow("Model not found: anthropic/does-not-exist");
  });

  test("a session with no model of its own seeds Pi's lane from the current default model; its own model wins, its thinking 'off' being no level", () => {
    const project = createProject("Test Project", repo.dir, "main");
    createSession("unset", project.id, { agentRuntimeType: "pi" });
    createSession("own", project.id, { agentRuntimeType: "pi", modelProvider: "openai", modelId: "gpt-5", thinkingLevel: "off" });
    setSetting("default_model", { provider: "anthropic", modelId: "claude-sonnet-4-5", runtimeType: "pi", thinkingLevel: "high" });
    expect(sessionTarget("unset").lane).toEqual({ model: { provider: "anthropic", modelId: "claude-sonnet-4-5" }, thinkingLevel: "high" });
    // Read when the command is sent: a later default applies to a session whose lane is not seeded yet.
    setSetting("default_model", { provider: "anthropic", modelId: "claude-haiku-4-5", runtimeType: "pi", thinkingLevel: "low" });
    expect(sessionTarget("unset").lane).toEqual({ model: { provider: "anthropic", modelId: "claude-haiku-4-5" }, thinkingLevel: "low" });
    expect(sessionTarget("own").lane).toEqual({ model: { provider: "openai", modelId: "gpt-5" }, thinkingLevel: null });
  });
});

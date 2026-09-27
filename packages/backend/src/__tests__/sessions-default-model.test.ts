import { nodeRuntimesForTesting } from "@reins/node/node";
import { describe, test, expect } from "bun:test";
import { useTestDb } from "./helpers/test-db.js";
import { useTestRepo } from "./helpers/test-repo.js";
import { createServerState } from "./helpers/server-state.js";
import { createProject } from "../project-store.js";
import { getSession } from "./session-fixture.js";
import { setSetting, deleteSetting } from "../settings-store.js";
import { createNewSession } from "../runtimes/session-manager.js";
import { getNodeCommand } from "../node-command-store.js";
import { sessionBinding } from "../runtimes/node-source.js";
import { drainCommands, loopbackNodeFor } from "./helpers/loopback-node.js";
import type { ServerState } from "../state.js";

/** Test seam: the node opens its runtime on command; tests observe what that open does. */
const openOnNode = (state: ServerState, sessionId: string) =>
  nodeRuntimesForTesting(loopbackNodeFor(state)).open(sessionId, sessionBinding(sessionId).binding);

describe("canonical session model selection", () => {
  useTestDb();
  const repo = useTestRepo();

  test("requires an explicit configured model for a new session", async () => {
    deleteSetting("default_model");
    const state = createServerState(undefined, { loopbackNode: true });
    const project = createProject("Test Project", repo.dir, "main");
    const created = createNewSession(state, project.id);
    await drainCommands(state);
    expect(getNodeCommand(created.provisionCommandId)).toBeNull();
    expect(getSession(created.id)?.placement_status).toBe("provisioned");
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
  });

  test("applies configured model and thinking to a new session", async () => {
    setSetting("default_model", { provider: "anthropic", modelId: "claude-sonnet-4-5", runtimeType: "pi", thinkingLevel: "high" });
    const state = createServerState(undefined, { loopbackNode: true });
    const project = createProject("Test Project", repo.dir, "main");
    const managed = await createNewSession(state, project.id);
    await drainCommands(state);
    const opened = await openOnNode(state, managed.id);
    expect(opened.getSessionMetadata()).toEqual({ model: { provider: "anthropic", modelId: "claude-sonnet-4-5" }, thinkingLevel: "high" });
    expect(getSession(managed.id)).toMatchObject({ agent_runtime_type: "pi", model_provider: "anthropic", model_id: "claude-sonnet-4-5", thinking_level: "high" });
    await nodeRuntimesForTesting(loopbackNodeFor(state)).close(managed.id);
  });

  test("reports an invalid configured model without fallback", async () => {
    setSetting("default_model", { provider: "anthropic", modelId: "does-not-exist", runtimeType: "pi", thinkingLevel: "high" });
    const state = createServerState(undefined, { loopbackNode: true });
    const sent: Array<{ type: string; sessionId?: string; error?: string }> = [];
    state.clients.add({ ws: { send: (data: string) => { sent.push(JSON.parse(data)); return 0; } } });
    const project = createProject("Test Project", repo.dir, "main");
    const created = createNewSession(state, project.id);
    await drainCommands(state);
    // The node rejects the provision: Pi cannot create the session's lane with a model it does not know.
    expect(sent).toContainEqual({ type: "error", sessionId: created.id, error: "Session provisioning failed: Model not found: anthropic/does-not-exist" });
    expect(getNodeCommand(created.provisionCommandId)).toBeNull();
    expect(getSession(created.id)).toMatchObject({ placement_status: "provision_failed", status_error: "Model not found: anthropic/does-not-exist" });
    await expect(openOnNode(state, created.id)).rejects.toThrow("This session's node data is missing");
  });
});

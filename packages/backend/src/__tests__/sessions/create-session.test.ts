import { createSource, defaultSource } from "../../node-store.js";
import { pendingInputs } from "../../node-link/node-command-store.js";
import { drainCommands, loopbackNodeFor, openingTarget } from "../helpers/loopback-node.js";
import { setSetting, deleteSetting } from "../../settings-store.js";
import { nodeRuntimesForTesting } from "@reins/node/node";
import { submit } from "../../sessions/node-execution.js";
import { describe, test, expect } from "bun:test";
import { getDb } from "../../db.js";
import { createProject } from "../project-fixture.js";
import { getSession } from "../session-fixture.js";
import { createTask, getTask } from "../../task-store.js";
import { useTestDb } from "../helpers/test-db.js";
import { createServerState } from "../helpers/server-state.js";
import { useTestRepo } from "../helpers/test-repo.js";
import { createSession as createNewSession } from "../../sessions/create-session.js";
import { registerSessionKind } from "../../sessions/session-kinds.js";
import type { ServerState } from "../../state.js";

/** Test seam: the node opens its runtime as an opening command for the session would; tests observe what
 * that open does. */
const openOnNode = (state: ServerState, sessionId: string) => nodeRuntimesForTesting(loopbackNodeFor(state)).open(sessionId, openingTarget(sessionId));

describe("createSession", () => {
  useTestDb();
  const repo = useTestRepo();

  test("createSession persists the runtime, selected model and thinking level, and queues nothing", () => {
    const state = createServerState();
    const project = createProject("Reins", repo.dir);

    const managed = createNewSession(state, project.id, {
      model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
      thinkingLevel: "high",
    });

    expect(getSession(managed.id)).toMatchObject({ agent_runtime_type: "pi", model_provider: "anthropic", model_id: "claude-sonnet-4-5", thinking_level: "high" });
    expect(getDb().query("SELECT COUNT(*) AS n FROM node_command_outbox").get()).toEqual({ n: 0 });
  });
  test("a new session is placed on its project's default source (its first) unless the caller names one; input for a node that is not connected waits", async () => {
    const project = createProject("a", "/tmp/a");
    // The source the project was created with.
    const first = defaultSource(project.id)!;
    expect(first).toMatchObject({ project_id: project.id, path: "/tmp/a" });
    getDb().exec("INSERT INTO nodes VALUES ('remote', 'Remote')");
    const remote = createSource(project.id, "remote", "/remote/a");
    expect(defaultSource(project.id)).toEqual(first);
    const other = createProject("b", "/tmp/b");
    const state = createServerState();
    expect(() => createNewSession(state, project.id, { sourceId: defaultSource(other.id)!.id })).toThrow("Source not found");

    expect(getSession(createNewSession(state, project.id).id)?.source_id).toBe(first.id);
    const far = createNewSession(state, project.id, { sourceId: remote.id });
    expect(getSession(far.id)?.source_id).toBe(remote.id);
    // Queued until the remote node connects, not rejected.
    submit(state.nodes, far.id, { op: "steer", content: [{ type: "text", text: "hi" }], clientId: "c" });
    await drainCommands(state);
    expect(pendingInputs(far.id)).toEqual([{ id: expect.any(String), clientId: "c" }]);
  });

  test("requires an explicit configured model for a new session", async () => {
    deleteSetting("default_model");
    const state = createServerState(undefined, { loopbackNode: true });
    const project = createProject("Test Project", repo.dir, "main");
    const created = createNewSession(state, project.id);
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

  test("a background session is stored as one and leaves its task's place in the task list alone", () => {
    const state = createServerState();
    const project = createProject("Reins", repo.dir);
    const task = createTask(project.id, "Task", null, "task/t");
    getDb().query("UPDATE tasks SET updated_at = '2025-01-01T00:00:00.000Z' WHERE id = ?").run(task.id);
    const model = { provider: "anthropic", modelId: "claude-sonnet-4-5" };

    const hidden = createNewSession(state, project.id, { taskId: task.id, model, thinkingLevel: "high", background: true });
    expect(getSession(hidden.id)).toMatchObject({ task_id: task.id, background: 1 });
    expect(getTask(task.id)!.updated_at).toBe("2025-01-01T00:00:00.000Z");

    const visible = createNewSession(state, project.id, { taskId: task.id, model, thinkingLevel: "high" });
    expect(getSession(visible.id)).toMatchObject({ background: 0 });
    expect(getTask(task.id)!.updated_at).not.toBe("2025-01-01T00:00:00.000Z");
  });

  test("a session is of the agent kind unless created as another registered kind; an unknown kind creates nothing", () => {
    const state = createServerState();
    const project = createProject("Reins", repo.dir);
    const model = { provider: "anthropic", modelId: "claude-sonnet-4-5" };
    const unregister = registerSessionKind("test-sorter", () => ({ systemPrompt: "Sort these.", tools: [], environment: false }));
    try {
      const agent = createNewSession(state, project.id, { model, thinkingLevel: "high" });
      const sorter = createNewSession(state, project.id, { model, thinkingLevel: "high", kind: "test-sorter", background: true });
      expect(getSession(agent.id)).toMatchObject({ kind: "agent" });
      expect(getSession(sorter.id)).toMatchObject({ kind: "test-sorter", background: 1 });

      expect(() => createNewSession(state, project.id, { model, thinkingLevel: "high", kind: "nonexistent" })).toThrow("Unknown session kind: nonexistent");
      expect(getDb().query("SELECT id FROM sessions ORDER BY created_at").all()).toEqual([{ id: agent.id }, { id: sorter.id }]);
    } finally { unregister(); }
  });
});

import { upsertSource, defaultSource } from "../../node-store.js";
import { setSetting, deleteSetting } from "../../settings-store.js";
import { Sessions } from "../../models/sessions.js";
import { describe, test, expect } from "bun:test";
import { getDb } from "../../app-globals.js";
import { storedInput } from "../../pi-session-store.js";
import { createProject } from "../project-fixture.js";
import { getSession } from "../session-fixture.js";
import { createTask, getTask } from "../../task-store.js";
import { getProject } from "../../project-store.js";
import { useTestDb } from "../helpers/test-db.js";
import { createAppState, type TestAppState } from "../helpers/app-state.js";
import { useTestRepo } from "../helpers/test-repo.js";
import { createSession as createNewSession } from "../../sessions/create-session.js";
import { registerSessionKind } from "../../sessions/session-kinds.js";
import { openSessionRuntime } from "../../session-runtime/live.js";
import { AgentHarnessPiRuntime } from "../../session-runtime/pi-runtime.js";

/** Opens the session's runtime on the server, as its first submission does; tests observe what that open does. */
const openRuntime = async (state: TestAppState, sessionId: string): Promise<AgentHarnessPiRuntime> => {
  const runtime = await openSessionRuntime(state.process, sessionId);
  if (!(runtime instanceof AgentHarnessPiRuntime)) throw new Error("Not a Pi runtime");
  return runtime;
};

describe("createSession", () => {
  useTestDb();
  const repo = useTestRepo();

  test("createSession persists the runtime, selected model and thinking level, and opens nothing", () => {
    const state = createAppState();
    const project = createProject("Reins", repo.dir);

    const managed = createNewSession(state, {
      projectId: project.id,
      model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
      thinkingLevel: "high",
    });

    expect(getSession(managed.id)).toMatchObject({ agent_runtime_type: "pi", model_provider: "anthropic", model_id: "claude-sonnet-4-5", thinking_level: "high" });
    expect(state.process.sessions.live.size).toBe(0);
  });
  test("a new session works where it is told, else in its parent's source, its task's latest session's, or its project's home; input for a node that is not connected is admitted", async () => {
    const project = createProject("a", "/tmp/a");
    const home = defaultSource(project.id)!;
    getDb().exec("INSERT INTO nodes (id, name) VALUES ('remote', 'Remote')");
    const remote = upsertSource("remote", "/remote/a");
    const elsewhere = upsertSource("remote", "/remote/elsewhere");
    const task = createTask(project.id, "T", null, "task/t");
    const state = createAppState();
    const sourceOf = (created: { id: string }) => getSession(created.id)?.source_id;

    expect(sourceOf(createNewSession(state, { projectId: project.id }))).toBe(home.id);
    const far = createNewSession(state, { projectId: project.id, sourceId: remote.id, model: { provider: "anthropic", modelId: "claude-sonnet-4-5" } });
    expect(sourceOf(far)).toBe(remote.id);
    expect(sourceOf(createNewSession(state, { projectId: project.id, parentSessionId: far.id }))).toBe(remote.id);
    expect(sourceOf(createNewSession(state, { projectId: project.id, taskId: task.id }))).toBe(home.id);
    createNewSession(state, { projectId: project.id, taskId: task.id, sourceId: elsewhere.id });
    expect(sourceOf(createNewSession(state, { projectId: project.id, taskId: task.id }))).toBe(elsewhere.id);
    expect(() => createNewSession(state, { projectId: project.id, sourceId: 9999 })).toThrow("Source not found: 9999");
    // Admitted while the remote node is offline (its run waits for it), not rejected.
    await new Sessions(state, () => {}).submit(far.id, { op: "steer", content: [{ type: "text", text: "hi" }], clientId: "c" });
    expect(storedInput(far.id, "c")).not.toBeNull();
  });

  test("a session of no project works in the source it names, and has no task", () => {
    const project = createProject("a", "/tmp/a");
    const task = createTask(project.id, "T", null, "task/t");
    const scratch = upsertSource("internal", "/tmp/scratch");
    const state = createAppState();
    const sessions = () => getDb().query("SELECT id FROM sessions").all();

    const loose = createNewSession(state, { sourceId: scratch.id, background: true });

    expect(getSession(loose.id)).toMatchObject({ project_id: null, task_id: null, source_id: scratch.id, background: 1 });
    expect(() => createNewSession(state, {})).toThrow("A session of no project needs a source");
    expect(() => createNewSession(state, { sourceId: scratch.id, taskId: task.id })).toThrow("A session of no project has no task");
    expect(sessions()).toEqual([{ id: loose.id }]);
  });

  test("requires an explicit configured model for a new session", async () => {
    deleteSetting("default_model");
    const state = createAppState();
    const project = createProject("Test Project", repo.dir, "main");
    const created = createNewSession(state, { projectId: project.id });
    await expect(openRuntime(state, created.id)).rejects.toThrow("requires an explicit model");
  });

  test("rejects a Claude-runtime default instead of routing it through Pi", async () => {
    setSetting("default_model", {
      provider: "claude_agent_sdk",
      modelId: "claude-sonnet-4-6",
      runtimeType: "claude_agent_sdk",
      thinkingLevel: "high",
    });
    const state = createAppState();
    const project = createProject("Test Project", repo.dir, "main");
    expect(() => createNewSession(state, { projectId: project.id })).toThrow("Configured default_model uses unavailable runtime 'claude_agent_sdk'");
  });

  test("applies configured model and thinking to a new session", async () => {
    setSetting("default_model", { provider: "anthropic", modelId: "claude-sonnet-4-5", runtimeType: "pi", thinkingLevel: "high" });
    const state = createAppState();
    const project = createProject("Test Project", repo.dir, "main");
    const managed = createNewSession(state, { projectId: project.id });
    const opened = await openRuntime(state, managed.id);
    expect(opened.getSessionMetadata()).toEqual({ model: { provider: "anthropic", modelId: "claude-sonnet-4-5" }, thinkingLevel: "high" });
    expect(getSession(managed.id)).toMatchObject({ agent_runtime_type: "pi", model_provider: "anthropic", model_id: "claude-sonnet-4-5", thinking_level: "high" });
  });

  test("reports an invalid configured model without fallback", async () => {
    setSetting("default_model", { provider: "anthropic", modelId: "does-not-exist", runtimeType: "pi", thinkingLevel: "high" });
    const state = createAppState();
    const project = createProject("Test Project", repo.dir, "main");
    const created = createNewSession(state, { projectId: project.id });
    // The runtime does not open: Pi cannot create its lane with a model the server's catalog does not have.
    await expect(openRuntime(state, created.id)).rejects.toThrow("Model not found: anthropic/does-not-exist");
  });

  test("a background session is stored as one, is not announced to browsers and leaves its task's and project's places in their lists alone", () => {
    const sent: Array<{ type: string; sessionId: string }> = [];
    const state = createAppState({ clients: new Set([{ ws: { send(payload: string) { sent.push(JSON.parse(payload)); return payload.length; } } }]) });
    const project = createProject("Reins", repo.dir);
    const task = createTask(project.id, "Task", null, "task/t");
    getDb().query("UPDATE tasks SET updated_at = '2025-01-01T00:00:00.000Z' WHERE id = ?").run(task.id);
    getDb().query("UPDATE projects SET last_opened_at = '2025-01-01T00:00:00.000Z' WHERE id = ?").run(project.id);
    const model = { provider: "anthropic", modelId: "claude-sonnet-4-5" };

    const hidden = createNewSession(state, { projectId: project.id, taskId: task.id, model, thinkingLevel: "high", background: true });
    expect(getSession(hidden.id)).toMatchObject({ task_id: task.id, background: 1 });
    expect(getTask(task.id)!.updated_at).toBe("2025-01-01T00:00:00.000Z");
    expect(getProject(project.id)!.last_opened_at).toBe("2025-01-01T00:00:00.000Z");

    const visible = createNewSession(state, { projectId: project.id, taskId: task.id, model, thinkingLevel: "high" });
    expect(getSession(visible.id)).toMatchObject({ background: 0 });
    expect(getTask(task.id)!.updated_at).not.toBe("2025-01-01T00:00:00.000Z");
    expect(getProject(project.id)!.last_opened_at).not.toBe("2025-01-01T00:00:00.000Z");
    expect(sent.map(message => [message.type, message.sessionId])).toEqual([["session_created", visible.id]]);
  });

  test("a session is of the agent kind unless created as another registered kind; an unknown kind creates nothing", () => {
    const state = createAppState();
    const project = createProject("Reins", repo.dir);
    const model = { provider: "anthropic", modelId: "claude-sonnet-4-5" };
    const unregister = registerSessionKind("test-sorter", () => ({ systemPrompt: "Sort these.", tools: [], environment: false }));
    try {
      const agent = createNewSession(state, { projectId: project.id, model, thinkingLevel: "high" });
      const sorter = createNewSession(state, { projectId: project.id, model, thinkingLevel: "high", kind: "test-sorter", background: true });
      expect(getSession(agent.id)).toMatchObject({ kind: "agent" });
      expect(getSession(sorter.id)).toMatchObject({ kind: "test-sorter", background: 1 });

      expect(() => createNewSession(state, { projectId: project.id, model, thinkingLevel: "high", kind: "nonexistent" })).toThrow("Unknown session kind: nonexistent");
      expect(getDb().query("SELECT id FROM sessions ORDER BY created_at").all()).toEqual([{ id: agent.id }, { id: sorter.id }]);
    } finally { unregister(); }
  });
});

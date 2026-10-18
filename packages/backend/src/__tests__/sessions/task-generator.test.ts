import { describe, test, expect, beforeEach } from "bun:test";
import { generateTask } from "../../sessions/task-generator.js";
import { SessionModel } from "../../models/session.js";
import { createSession as createNewSession } from "../../sessions/create-session.js";
import { TASK_GENERATOR_KIND } from "../../sessions/session-kinds.js";
import { deleteSetting, setSetting } from "../../settings-store.js";
import { defaultSource, getSource } from "../../node-store.js";
import { getSession } from "../../session-store.js";
import { createTask } from "../../task-store.js";
import { getDb } from "../../app-globals.js";
import { createProject } from "../project-fixture.js";
import { useTestDb } from "../helpers/test-db.js";
import { useTestRepo } from "../helpers/test-repo.js";
import { createAppState, type TestAppState } from "../helpers/app-state.js";
import { useFakeModel } from "../helpers/fake-model.js";
import type { WsClient } from "../../state.js";

const fallback = {
  title: "add dark mode support",
  description: "add dark mode support",
  branch_name: "task/add-dark-mode-support",
};

/** Every frame broadcast to browsers. */
function capturedBroadcasts(state: TestAppState): Array<{ type: string; sessionId?: string }> {
  const sent: Array<{ type: string; sessionId?: string }> = [];
  const client: WsClient = { ws: { send(payload: string) { sent.push(JSON.parse(payload)); return payload.length; } } };
  state.process.clients.add(client);
  return sent;
}

/** Nothing of the generation session is left on the server: no row, no live runtime. */
function expectNoSessionLeft(state: TestAppState): void {
  expect(getDb().query("SELECT id FROM sessions").all()).toEqual([]);
  expect([...state.process.sessions.live.keys()]).toEqual([]);
}

describe("generateTask", () => {
  useTestDb();
  const repo = useTestRepo();
  const model = useFakeModel();
  let state: TestAppState;
  let source: NonNullable<ReturnType<typeof defaultSource>>;

  beforeEach(() => {
    deleteSetting("utility_model");
    deleteSetting("default_model");
    setSetting("utility_model", { provider: model.model.provider, modelId: model.model.modelId, runtimeType: "pi", thinkingLevel: "minimal" });
    // No node is connected: a task-generator session needs none (no tools, no environment, no checkout).
    state = createAppState();
    source = defaultSource(createProject("Reins", repo.dir).id)!;
  });

  const firstTurn = async () => {
    for (let i = 0; i < 400 && !model.turns.length; i++) await Bun.sleep(5);
    const turn = model.turns[0];
    if (!turn) throw new Error("No model request was made");
    return turn;
  };

  test("runs the user's text as a background session of the task-generator kind with the utility model, with every node offline, parses its reply and deletes the session", async () => {
    const broadcasts = capturedBroadcasts(state);
    const generating = generateTask(state, source, "add dark mode support");

    const turn = await firstTurn();
    expect(turn.input).toBe("add dark mode support");
    expect(turn.context.tools ?? []).toEqual([]);
    expect(getSession(turn.sessionId)).toMatchObject({ kind: TASK_GENERATOR_KIND, background: 1, source_id: source.id, model_provider: model.model.provider, model_id: "fake", thinking_level: "minimal" });
    turn.finish({ reply: "```json\n{\"title\": \" Add dark mode \", \"description\": \"Theme toggle.\", \"branch_name\": \"task/dark-mode\"}\n```" });

    expect(await generating).toEqual({ title: "Add dark mode", description: "Theme toggle.", branch_name: "task/dark-mode" });
    expectNoSessionLeft(state);
    expect(broadcasts.filter(message => message.type === "session_created")).toEqual([]);
  });

  test("an unparseable reply gives the deterministic task", async () => {
    const generating = generateTask(state, source, "add dark mode support");
    (await firstTurn()).finish({ reply: "Sure! Here is your task: dark mode." });
    expect(await generating).toEqual(fallback);
    expectNoSessionLeft(state);
  });

  test("a failed run gives the deterministic task", async () => {
    const generating = generateTask(state, source, "add dark mode support");
    (await firstTurn()).finish({ status: "failed", error: "Provider refused the request" });
    expect(await generating).toEqual(fallback);
    expectNoSessionLeft(state);
  });

  test("a run that does not settle in time gives the deterministic task; its runtime is closed (its run aborted) and the session deleted", async () => {
    const generating = generateTask(state, source, "add dark mode support", { timeoutMs: 200 });
    await firstTurn();
    expect(await generating).toEqual(fallback);
    expectNoSessionLeft(state);
  });

  test("a model the server's catalog does not have gives the deterministic task", async () => {
    setSetting("utility_model", { provider: model.model.provider, modelId: "missing", runtimeType: "pi", thinkingLevel: "minimal" });
    expect(await generateTask(state, source, "add dark mode support")).toEqual(fallback);
    expectNoSessionLeft(state);
  });

  test("with no utility or default model it gives the deterministic task without creating a session", async () => {
    deleteSetting("utility_model");
    const broadcasts = capturedBroadcasts(state);
    expect(await generateTask(state, source, "add dark mode support")).toEqual(fallback);
    expectNoSessionLeft(state);
    expect(broadcasts).toEqual([]);
  });

  test("rejects an inert utility runtime instead of falling back", async () => {
    setSetting("utility_model", { provider: "anthropic", modelId: "claude-haiku-4-5", runtimeType: "claude_agent_sdk", thinkingLevel: "minimal" });
    await expect(generateTask(state, source, "add dark mode"))
      .rejects.toThrow("Configured utility model uses unavailable runtime 'claude_agent_sdk'");
  });
});

describe("the task-generator kind", () => {
  useTestDb();
  const repo = useTestRepo();

  test("runs its fixed prompt with no tools, no node environment and no branch, even on a task session", () => {
    const project = createProject("Reins", repo.dir);
    const task = createTask(project.id, "Task", "Do it", "task/do-it");
    const created = createNewSession(createAppState(), project.id, {
      taskId: task.id, kind: TASK_GENERATOR_KIND, background: true,
      model: { provider: "anthropic", modelId: "claude-haiku-4-5" }, thinkingLevel: "minimal",
    });
    const row = getSession(created.id)!;
    const { branch, runtime } = new SessionModel(row).context(getSource(row.source_id)!);

    expect(branch).toBeNull();
    expect(runtime).toEqual({ systemPrompt: expect.stringContaining("You parse user intent into a structured task definition."), tools: [], environment: false });
    expect(runtime.systemPrompt).not.toContain("Do it");
  });
});

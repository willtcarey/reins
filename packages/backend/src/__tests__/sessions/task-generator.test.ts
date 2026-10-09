import { describe, test, expect, beforeEach } from "bun:test";
import { generateTask } from "../../sessions/task-generator.js";
import { SessionModel } from "../../models/session.js";
import { createSession as createNewSession } from "../../sessions/create-session.js";
import { TASK_GENERATOR_KIND } from "../../sessions/session-kinds.js";
import { deleteSetting, setSetting } from "../../settings-store.js";
import { defaultSource, getSource } from "../../node-store.js";
import { getSession } from "../../session-store.js";
import { createTask } from "../../task-store.js";
import { getDb } from "../../db.js";
import { createProject } from "../project-fixture.js";
import { useTestDb } from "../helpers/test-db.js";
import { useTestRepo } from "../helpers/test-repo.js";
import { createServerState } from "../helpers/server-state.js";
import { useFakeNode, type FakeNode } from "../helpers/fake-node.js";
import type { ServerState, WsClient } from "../../state.js";

const fallback = {
  title: "add dark mode support",
  description: "add dark mode support",
  branch_name: "task/add-dark-mode-support",
};

/** Every frame broadcast to browsers. */
function capturedBroadcasts(state: ServerState): Array<{ type: string; sessionId?: string }> {
  const sent: Array<{ type: string; sessionId?: string }> = [];
  const client: WsClient = { ws: { send(payload: string) { sent.push(JSON.parse(payload)); return payload.length; } } };
  state.clients.add(client);
  return sent;
}

/** Nothing of the generation session is left on the server. */
function expectNoSessionLeft(): void {
  expect(getDb().query("SELECT id FROM sessions").all()).toEqual([]);
  expect(getDb().query("SELECT id FROM node_command_outbox").all()).toEqual([]);
}

async function nextTurn(node: FakeNode) {
  for (let i = 0; i < 200 && !node.turns.length; i++) await Bun.sleep(5);
  const turn = node.turns[0];
  if (!turn) throw new Error("The node started no run");
  return turn;
}

describe("generateTask", () => {
  useTestDb();
  const repo = useTestRepo();
  let state: ServerState;
  let source: NonNullable<ReturnType<typeof defaultSource>>;

  beforeEach(() => {
    deleteSetting("utility_model");
    deleteSetting("default_model");
    setSetting("utility_model", { provider: "anthropic", modelId: "claude-haiku-4-5", runtimeType: "pi", thinkingLevel: "minimal" });
    state = createServerState();
    source = defaultSource(createProject("Reins", repo.dir).id)!;
  });

  test("runs the user's text as a background session of the task-generator kind on the source's node with the utility model, parses its reply and deletes the session", async () => {
    const node = useFakeNode(state);
    const broadcasts = capturedBroadcasts(state);
    const generating = generateTask(state, source, "add dark mode support");

    const turn = await nextTurn(node);
    expect(turn.input).toEqual([{ type: "text", text: "add dark mode support" }]);
    expect(getSession(turn.sessionId)).toMatchObject({ kind: TASK_GENERATOR_KIND, background: 1, source_id: source.id, model_provider: "anthropic", model_id: "claude-haiku-4-5", thinking_level: "minimal" });
    turn.finish({ reply: "```json\n{\"title\": \" Add dark mode \", \"description\": \"Theme toggle.\", \"branch_name\": \"task/dark-mode\"}\n```" });

    expect(await generating).toEqual({ title: "Add dark mode", description: "Theme toggle.", branch_name: "task/dark-mode" });
    expectNoSessionLeft();
    for (let i = 0; i < 100 && !node.closed.length; i++) await Bun.sleep(5);
    expect(node.closed).toEqual([turn.sessionId]);
    expect(broadcasts.filter(message => message.type === "session_created")).toEqual([]);
  });

  test("an unparseable reply gives the deterministic task", async () => {
    const node = useFakeNode(state);
    const generating = generateTask(state, source, "add dark mode support");
    (await nextTurn(node)).finish({ reply: "Sure! Here is your task: dark mode." });
    expect(await generating).toEqual(fallback);
    expectNoSessionLeft();
  });

  test("a failed run gives the deterministic task", async () => {
    const node = useFakeNode(state);
    const generating = generateTask(state, source, "add dark mode support");
    (await nextTurn(node)).finish({ status: "failed", error: "Provider overloaded" });
    expect(await generating).toEqual(fallback);
    expectNoSessionLeft();
  });

  test("a run that does not settle in time gives the deterministic task, and its node is told to close it", async () => {
    const node = useFakeNode(state);
    const generating = generateTask(state, source, "add dark mode support", { timeoutMs: 200 });
    const turn = await nextTurn(node);
    expect(await generating).toEqual(fallback);
    expectNoSessionLeft();
    for (let i = 0; i < 100 && !node.closed.length; i++) await Bun.sleep(5);
    expect(node.closed).toEqual([turn.sessionId]);
  });

  test("with the node offline the prompt waits in the outbox until the timeout, then is deleted with the session", async () => {
    expect(await generateTask(state, source, "add dark mode support", { timeoutMs: 50 })).toEqual(fallback);
    expectNoSessionLeft();
  });

  test("with no utility or default model it gives the deterministic task without creating a session", async () => {
    deleteSetting("utility_model");
    const broadcasts = capturedBroadcasts(state);
    expect(await generateTask(state, source, "add dark mode support")).toEqual(fallback);
    expectNoSessionLeft();
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
    const created = createNewSession(createServerState(), project.id, {
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

import { afterEach, describe, expect, test } from "bun:test";
import type { BeforeRun, BeforeRunHook, MessageContent, ServerSdk } from "@reins/sdk/server";
import { useTestDb } from "../../helpers/test-db.js";
import { git, useTestRepo } from "../../helpers/test-repo.js";
import { createAppState, type TestAppState } from "../../helpers/app-state.js";
import { loopbackLink, stopLoopbackNode } from "../../helpers/loopback-node.js";
import { useFakeModel } from "../../helpers/fake-model.js";
import { until } from "../../helpers/session-host.js";
import { createProject } from "../../project-fixture.js";
import { createTask } from "../../../task-store.js";
import { loadMessages } from "../../../messages-store.js";
import { latestSettlement } from "../../../sessions/session-runs.js";
import { suspendSessions } from "../../../process-state.js";
import { liveSessionRuntime, openSessionRuntime } from "../../../session-runtime/live.js";
import { Models } from "../../../models/models.js";
import { createApp } from "../../../app.js";

/** The text of a message's first block. */
const firstBlock = (message: MessageContent | null) => typeof message === "string" ? message : String(message?.[0]);

/** What a hook was called with, without its signal. */
type Seen = Omit<BeforeRun, "signal"> & { extension: string };

describe("reins.sessions.beforeRun", () => {
  useTestDb();
  const repo = useTestRepo();
  const model = useFakeModel();
  let state: TestAppState;
  let sdk: Record<string, ServerSdk>;
  let seen: Seen[];

  /** An app whose extensions register `hooks`, by extension name, in that order. */
  const start = async (hooks: Record<string, BeforeRunHook>) => {
    sdk = {};
    seen = [];
    state = createAppState(undefined, {
      loopbackNode: true,
      extensions: Object.entries(hooks).map(([name, hook]) => ({
        name,
        register: (reins: ServerSdk) => {
          sdk[name] = reins;
          return reins.sessions.beforeRun(async run => {
            const { signal: _signal, ...rest } = run;
            seen.push({ ...rest, extension: name });
            return hook(run);
          });
        },
      })),
    });
    await loopbackLink(state).ready();
  };

  afterEach(async () => {
    await stopLoopbackNode(state);
    await state.nodes.close();
  });

  const startSession = async (prompt: MessageContent, options: { taskId?: number } = {}) => {
    const project = createProject("Project", repo.dir);
    const first = Object.values(sdk)[0]!;
    return (await first.sessions.start(prompt, { projectId: project.id, model: model.model, ...options })).sessionId;
  };
  const settled = (sessionId: string) => until(() => latestSettlement(sessionId) !== null, "the run's end");
  const userTexts = (sessionId: string) => loadMessages(sessionId).filter(message => message.role === "user")
    .map(message => message.content.map((block: { text?: string }) => block.text).join("|"));

  test("is called before the run's first model request, with the session, its task, its tools and the run's message", async () => {
    let requestsWhenCalled = -1;
    await start({ one: () => { requestsWhenCalled = model.turns.length; } });
    const project = createProject("Project", repo.dir);
    const task = createTask(project.id, "Ship it", null, null);
    const { sessionId } = await sdk.one!.sessions.start("Hello", { projectId: project.id, taskId: task.id, model: model.model });

    (await model.nextTurn(sessionId)).finish();
    await settled(sessionId);

    expect(requestsWhenCalled).toBe(0);
    expect(seen).toEqual([{
      extension: "one",
      session: expect.objectContaining({ id: sessionId, projectId: project.id, taskId: task.id, kind: "agent" }),
      task: expect.objectContaining({ id: task.id, title: "Ship it", branchName: null }),
      tools: null,
      message: ["Hello"],
    }]);
  });

  test("runs after Reins' own hook: a task's own branch is checked out when an extension's hook is called", async () => {
    let head = "";
    await start({ one: async () => { head = await git(repo.dir, ["rev-parse", "--abbrev-ref", "HEAD"]); } });
    const project = createProject("Project", repo.dir);
    const task = createTask(project.id, "Ship it", null, "task/ship-it");
    const { sessionId } = await sdk.one!.sessions.start("Hello", { projectId: project.id, taskId: task.id, model: model.model });

    (await model.nextTurn(sessionId)).finish();
    await settled(sessionId);
    expect(head).toBe("task/ship-it");
  });

  test("hooks chain in order, each getting the message the one before returned; the model and the chat get the last one", async () => {
    await start({
      first: run => [`${firstBlock(run.message)} (first)`, { text: "Context from first", hidden: true, label: "First" }],
      second: () => undefined,
      third: run => [`${firstBlock(run.message)} (third)`],
    });
    const sessionId = await startSession("Hello");

    const turn = await model.nextTurn(sessionId);
    expect(seen.map(entry => [entry.extension, entry.message])).toEqual([
      ["first", ["Hello"]],
      ["second", ["Hello (first)", { text: "Context from first", hidden: true, label: "First" }]],
      ["third", ["Hello (first)", { text: "Context from first", hidden: true, label: "First" }]],
    ]);
    expect(turn.input).toBe("Hello (first) (third)");
    expect(JSON.stringify(turn.context.messages)).not.toContain("\"Hello\"");
    turn.finish();
    await settled(sessionId);

    const replacement = loadMessages(sessionId).filter(message => message.role === "user").at(-1);
    expect(replacement).toMatchObject({ content: [{ type: "text", text: "Hello (first) (third)" }], metadata: { replaces: expect.any(String), sourceExtension: "first" } });
  });

  test("a hook that throws fails the run with its message, without asking the model", async () => {
    await start({ refuses: () => { throw new Error("Not today."); } });
    const sessionId = await startSession("Hello");

    await settled(sessionId);
    expect(latestSettlement(sessionId)).toMatchObject({ status: "failed", error: { message: "Not today." } });
    expect(model.turns).toHaveLength(0);
  });

  test("a run that resumes after a restart is prepared again, with no message", async () => {
    await start({ one: () => undefined });
    const sessionId = await startSession("Hello");
    await model.nextTurn(sessionId);

    await suspendSessions(state.process.sessions, { pauseMs: 50 });
    state.process.sessions.pauseGate.open();
    expect(await (await openSessionRuntime(state.process, sessionId)).resumePendingOperation()).toBe(true);
    (await model.nextTurn(sessionId)).finish();
    await settled(sessionId);

    expect(seen.map(entry => entry.message)).toEqual([["Hello"], null]);
  });

  test("a message steered into a running run does not call it; one that starts a run does", async () => {
    await start({ one: () => undefined });
    const sessionId = await startSession("Hello");
    const turn = await model.nextTurn(sessionId);

    await sdk.one!.sessions.send(sessionId, "Also this");
    await Bun.sleep(50);
    expect(seen).toHaveLength(1);
    turn.finish();
    (await model.nextTurn(sessionId)).finish();
    await settled(sessionId);
    expect(seen).toHaveLength(1);

    await sdk.one!.sessions.send(sessionId, "A new run");
    (await model.nextTurn(sessionId)).finish();
    await until(() => seen.length === 2, "the second run's hook");
    expect(seen[1]!.message).toEqual(["A new run"]);
  });

  test("a hook that waits is a pause point, and stopping the run aborts its signal: the run ends cancelled, the model not asked", async () => {
    let aborted = false;
    await start({ waits: ({ signal }) => new Promise<void>(resolve => signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true })) });
    const sessionId = await startSession("Hello");
    await until(() => seen.length === 1, "the hook");
    const runtime = (await liveSessionRuntime(state.process, sessionId))!;
    expect(runtime.isPaused()).toBe(true);

    await new Models(state).sessions.abort(sessionId);
    await settled(sessionId);

    expect(aborted).toBe(true);
    expect(latestSettlement(sessionId)).toMatchObject({ status: "aborted" });
    expect(model.turns).toHaveLength(0);
    expect(userTexts(sessionId)).toEqual(["Hello"]);
  });

  test("a run that starts during a reload's gap waits for the next app's hooks before it asks the model", async () => {
    await start({ one: () => undefined });
    const project = createProject("Project", repo.dir);
    const sessionId = (await new Models(state).sessions.create({ projectId: project.id, model: model.model })).id;
    state.process.registerApp(createApp(state))();
    expect(state.process.app).toBeUndefined();
    const runtime = await openSessionRuntime(state.process, sessionId);

    await runtime.prompt([{ type: "text", text: "Hello" }], { reinsId: "in-the-gap" });
    await Bun.sleep(150);
    expect(seen).toHaveLength(0);
    expect(model.turns).toHaveLength(0);
    expect(runtime.isPaused()).toBe(true);

    state.process.registerApp(createApp(state));
    (await model.nextTurn(sessionId)).finish();
    await settled(sessionId);
    expect(seen.map(entry => entry.message)).toEqual([["Hello"]]);
  });

  test("the order is fixed: an extension turned off and on again keeps its place", async () => {
    await start({ alpha: () => undefined, beta: () => undefined });
    await state.extensions.setEnabled("alpha", false);
    await state.extensions.setEnabled("alpha", true);
    const project = createProject("Project", repo.dir);
    const { sessionId } = await sdk.beta!.sessions.start("Hello", { projectId: project.id, model: model.model });

    (await model.nextTurn(sessionId)).finish();
    await settled(sessionId);
    expect(seen.map(entry => entry.extension)).toEqual(["alpha", "beta"]);
  });
});

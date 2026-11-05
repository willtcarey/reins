import { describe, expect, test } from "bun:test";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { Type } from "@sinclair/typebox";
import { SessionHandleSchema, SessionSchema } from "../../sdk-host/sessions.js";
import { createProject } from "../project-fixture.js";
import { upsertSource } from "../../node-store.js";
import { createSession as insertSession } from "../../session-store.js";
import { createTask } from "../../task-store.js";
import { createSession, getSession, listSessions, updateActivityState, updateSessionMetadata } from "../session-fixture.js";
import { loadMessages } from "../../messages-store.js";
import { getDb } from "../../app-globals.js";
import { createSession as createNewSession } from "../../sessions/create-session.js";
import { Sessions } from "../../models/sessions.js";
import { buildApiObject, searchFunctions, referencedTypes } from "../../sdk-host/scripts.js";
import { useTestDb } from "../helpers/test-db.js";
import { createTestRepo, useTestRepo } from "../helpers/test-repo.js";
import { stubRuntime, useLoopbackState } from "../helpers/app-state.js";
import { useFakeModel } from "../helpers/fake-model.js";
import { sessionActivity } from "../../models/session-activity.js";
import { persistCanonicalMessages } from "../helpers/canonical-messages.js";
import { executeTool, reinsTool } from "../helpers/execute-tool.js";
import { scriptContext } from "../helpers/script-context.js";

const text = (value: string) => [{ type: "text" as const, text: value }];

/** The inputs Pi admitted for `sessionId` (transcript entries and queued steering). */
const inputsOf = (sessionId: string) => [
  ...getDb().query<{ json: string }, [string]>("SELECT json_extract(message_json, '$.message') json FROM session_messages WHERE session_id = ? AND role = 'reinsInput' ORDER BY seq").all(sessionId),
  ...getDb().query<{ json: string }, [string]>("SELECT json_extract(value_json, '$.payload') json FROM pi_values WHERE session_id = ? AND namespace = 'pi.pending.entry' AND json_extract(value_json, '$.payload.role') = 'reinsInput' ORDER BY seq").all(sessionId),
].map(({ json }): Record<string, unknown> => JSON.parse(json));

async function admitted(turns: unknown[], count: number): Promise<void> {
  for (let i = 0; i < 200 && turns.length < count; i++) await Bun.sleep(10);
  expect(turns).toHaveLength(count);
}

describe("reins.sessions orchestration", () => {
  useTestDb();
  const repo = useTestRepo();
  const loopback = useLoopbackState();
  const model = useFakeModel();
  const provider = () => model.model.provider;

  function setup() {
    const { state } = loopback;
    // Every session runs on the server's runtimes, on the fake model; their tools on the loopback node.
    const project = createProject("Orchestration", repo.dir, "main");
    createSession("parent", project.id, {
      agentRuntimeType: "pi", modelProvider: provider(), modelId: "fake", thinkingLevel: "high",
    });
    const turns = model.turns;
    const broadcasts: unknown[] = [];
    // Node status and live session events are announced too.
    state.process.clients.add({ ws: { send: data => { const message = JSON.parse(data); if (message.type !== "node_updated" && message.type !== "event") broadcasts.push(message); return 0; } } });
    /** The script context of session `sessionId`, which exists. */
    const contextFor = (sessionId: string) => scriptContext(state, { sessionId });
    return { state, project, turns, broadcasts, contextFor, reins: buildApiObject(contextFor("parent")) };
  }
  /** Answers the session's model requests until it is idle. */
  async function answerUntilIdle(sessionId: string, reply?: string): Promise<void> {
    const answered = new Set<unknown>();
    for (let i = 0; i < 1000 && sessionActivity(getSession(sessionId)!, loopback.state.process.sessions) !== "idle"; i++) {
      const turn = model.turns.find(candidate => candidate.sessionId === sessionId && !answered.has(candidate));
      if (turn) { answered.add(turn); turn.finish(reply ? { reply } : {}); } else await Bun.sleep(5);
    }
  }

  /** The transcript as the server's storage holds it. */
  const transcript = (sessionId: string, role?: string) => loadMessages(sessionId).filter(message => !role || message.role === role).map(message => message.content);

  test("a session of no project lists the sessions of no project on its source, starts there or at a location it names, and reaches any session", async () => {
    const { state, project } = setup();
    const scratch = upsertSource("internal", repo.dir + "/..");
    const elsewhere = upsertSource("internal", "/tmp/elsewhere");
    for (const [id, sourceId] of [["loose", scratch.id], ["neighbour", scratch.id], ["far", elsewhere.id]] as const) {
      insertSession(id, null, { agentRuntimeType: "pi", modelProvider: provider(), modelId: "fake", sourceId, background: true });
    }
    const reins = buildApiObject(scriptContext(state, { sessionId: "loose" }));

    const listed = Value.Parse(Type.Array(SessionSchema), await reins.sessions.list({ background: "include" }));
    expect(listed.map(session => session.id).toSorted()).toEqual(["loose", "neighbour"]);
    const started = Value.Parse(SessionHandleSchema, await reins.sessions.start("Look around", { parentSessionId: null }));
    expect(getSession(started.sessionId)).toMatchObject({ project_id: null, task_id: null, source_id: scratch.id });
    await answerUntilIdle(started.sessionId);
    const placed = Value.Parse(SessionHandleSchema, await reins.sessions.start("Over there", { parentSessionId: null, source: { nodeId: "internal", path: "/tmp/elsewhere" } }));
    expect(getSession(placed.sessionId)).toMatchObject({ project_id: null, source_id: elsewhere.id });
    await answerUntilIdle(placed.sessionId);
    await expect(reins.sessions.send("neighbour", "Hello")).resolves.toBeUndefined();
    await answerUntilIdle("neighbour");
    await expect(reins.sessions.send("far", "Hello")).resolves.toBeUndefined();
    await answerUntilIdle("far");
    expect(await reins.sessions.setName("parent", "Renamed")).toMatchObject({ id: "parent", name: "Renamed" });
    await expect(reins.sessions.start("In a task", { parentSessionId: null, taskId: createTask(project.id, "T", null, "task/t").id })).rejects.toThrow("A session of no project has no task");
    await expect(reins.tasks.list()).rejects.toThrow("This session has no project, and tasks belong to projects");
    expect(await reins.projects.current()).toBeNull();
  });

  test("discovers unread activity and returns persisted status without marking sessions read", async () => {
    const { reins } = setup();
    const functions = searchFunctions("unread");
    expect(functions.map((fn) => fn.name)).toContain("sessions.list");
    expect(referencedTypes(functions).map((type) => JSON.stringify(type)).join("\n")).toContain("unread");
    for (const activity of [null, "running", "finished"] as const) {
      // Running is its live runtime's; unread is stored.
      if (activity === "running") stubRuntime(loopback.state.process, "parent");
      else loopback.state.process.sessions.live.delete("parent");
      updateActivityState("parent", activity === "finished" ? "finished" : null);
      const unread = activity === "finished";
      expect(await reins.sessions.current()).toMatchObject({ unread, pinned: false, archived: false });
      expect(await reins.sessions.get("parent")).toMatchObject({ unread, pinned: false, archived: false });
      expect(await reins.sessions.list()).toContainEqual(expect.objectContaining({
        id: "parent", unread, pinned: false, archived: false,
      }));
      expect(getSession("parent")!.activity_state).toBe(activity);
    }
  });

  test("exposes pin and archive state as booleans without leaking persistence timestamps", async () => {
    const { reins } = setup();
    updateSessionMetadata("parent", { pinned: true, archived: true });

    const current = await reins.sessions.current();
    const fetched = await reins.sessions.get("parent");

    expect(current).toMatchObject({ pinned: true, archived: true });
    expect(fetched).toMatchObject({ pinned: true, archived: true });
    expect(current).not.toHaveProperty("pinned_at");
    expect(current).not.toHaveProperty("archived_at");
  });

  test("pins and archives independently through explicit session mutations", async () => {
    const { reins } = setup();

    expect(await reins.sessions.setPinned("parent", true)).toMatchObject({ pinned: true, archived: false });
    expect(await reins.sessions.setArchived("parent", true)).toMatchObject({ pinned: true, archived: true });
    expect(await reins.sessions.setArchived("parent", false)).toMatchObject({ pinned: true, archived: false });
    expect(getSession("parent")).toMatchObject({ pinned_at: expect.any(String), archived_at: null });

    const otherProject = createProject("Other organization", `${repo.dir}-organization`, "main");
    createSession("foreign-organization", otherProject.id, { agentRuntimeType: "pi" });
    expect(await reins.sessions.setPinned("foreign-organization", true)).toMatchObject({ pinned: true });
  });

  test("renames and clears a session through an explicit scoped mutation", async () => {
    const { reins, broadcasts } = setup();

    expect(await reins.sessions.setName("parent", "  Important investigation  ")).toMatchObject({
      id: "parent",
      name: "Important investigation",
      pinned: false,
      archived: false,
    });
    expect(getSession("parent")!.name).toBe("Important investigation");
    expect(broadcasts).toEqual([{
      type: "session_updated",
      sessionId: "parent",
      projectId: expect.any(Number),
    }]);

    expect(await reins.sessions.setName("parent", null)).toMatchObject({ name: null });
    expect(getSession("parent")!.name).toBeNull();
  });

  test("rejects invalid names without side effects, and renames a session of another project", async () => {
    const { reins, broadcasts } = setup();
    updateSessionMetadata("parent", { name: "Original" });

    await expect(Promise.resolve().then(() => reins.sessions.setName("parent", "   "))).rejects.toThrow();
    expect(getSession("parent")!.name).toBe("Original");
    expect(broadcasts).toEqual([]);

    const otherProject = createProject("Other naming", `${repo.dir}-naming`, "main");
    createSession("foreign-name", otherProject.id, { agentRuntimeType: "pi" });
    updateSessionMetadata("foreign-name", { name: "Foreign original" });
    expect(await reins.sessions.setName("foreign-name", "Renamed here")).toMatchObject({ name: "Renamed here" });
  });

  test("starts immediately with explicit child/title semantics and waits for native settlement", async () => {
    const { reins, turns, project } = setup();
    const child = Value.Decode(SessionHandleSchema, await reins.sessions.start("Investigate", { parentSessionId: "current", title: "Investigation" }));
    expect(getSession(child.sessionId)).toMatchObject({
      name: "Investigation", parent_session_id: "parent", project_id: project.id,
      model_provider: provider(), model_id: "fake", thinking_level: "high",
    });
    await admitted(turns, 1);
    expect(turns[0].input).toBe("Investigate");
    expect(await reins.sessions.wait(child.sessionId, 0)).toMatchObject({ status: "timeout" });
    turns[0].finish({ reply: "response 1" });
    expect(await reins.sessions.wait(child.sessionId, 1000)).toMatchObject({ status: "completed", result: "response 1" });
    expect(transcript(child.sessionId)).toEqual([text("Investigate"), text("response 1")]);
  });

  test("a background session the server starts runs, settles and reports like any other, and scripts list it only when asked", async () => {
    const { reins, turns, state, project } = setup();
    const child = createNewSession(state, {
      projectId: project.id,
      parentSessionId: "parent", model: { provider: provider(), modelId: "fake" }, thinkingLevel: "high", background: true,
    });
    await new Sessions(state, () => {}).submit(child.id, { op: "prompt", content: text("Hidden work"), clientId: "hidden" });

    expect(await reins.sessions.get(child.id)).toMatchObject({ background: true, parentSessionId: "parent" });
    expect(await reins.sessions.current()).toMatchObject({ background: false });
    // Session kinds are the server's: scripts do not see them.
    expect(await reins.sessions.get(child.id)).not.toHaveProperty("kind");
    const listed = async (options?: object) => Value.Decode(Type.Array(SessionSchema), await reins.sessions.list(options)).map((session) => session.id);
    expect(await listed()).toEqual(["parent"]);
    expect(await listed({ background: "only" })).toEqual([child.id]);
    await admitted(turns, 1);
    expect(turns[0].input).toBe("Hidden work");
    turns[0].finish({ reply: "hidden result" });
    expect(await reins.sessions.wait(child.id, 1000)).toMatchObject({ status: "completed", result: "hidden result" });
    expect(transcript(child.id)).toEqual([text("Hidden work"), text("hidden result")]);
    // Its report prompts the parent.
    await admitted(turns, 2);
    expect(turns[1].sessionId).toBe("parent");
  });

  test("independent sessions preserve unnamed display defaults and allow model overrides", async () => {
    const { reins, turns, project } = setup();
    const session = Value.Decode(SessionHandleSchema, await reins.sessions.start("Independent", {
      parentSessionId: null, model: { provider: provider(), modelId: "other", thinkingLevel: "minimal" },
    }));
    expect(getSession(session.sessionId)).toMatchObject({ name: null, parent_session_id: null, model_id: "other", thinking_level: "minimal" });
    await admitted(turns, 1);
    turns[0].finish();
    await reins.sessions.wait(session.sessionId, 1000);
    expect(listSessions({ projectId: project.id }).find((row) => row.id === session.sessionId)?.first_message).toBe("Independent");
  });

  test("delivers to an existing session as steers, admitted in order, and resumes after settlement", async () => {
    const { reins, project } = setup();
    createSession("existing", project.id, { agentRuntimeType: "pi", modelProvider: provider(), modelId: "fake" });
    persistCanonicalMessages("existing", [{ role: "assistant", content: text("earlier"), timestamp: 1 }]);
    await Promise.all([reins.sessions.send("existing", "one"), reins.sessions.send("existing", "two")]);
    expect(await reins.sessions.wait("existing", 0)).toMatchObject({ status: "timeout" });
    await answerUntilIdle("existing", "response 3");
    expect(await reins.sessions.wait("existing", 1000)).toMatchObject({ status: "completed", result: "response 3" });
    expect(transcript("existing", "user")).toEqual([text("one"), text("two")]);
    await reins.sessions.send("existing", "resume");
    await answerUntilIdle("existing", "response 5");
    expect(await reins.sessions.wait("existing", 1000)).toMatchObject({ status: "completed", result: "response 5" });
    expect(transcript("existing", "user")).toEqual([text("one"), text("two"), text("resume")]);
  });

  test("validates parent, model, message and self-wait before side effects", async () => {
    const { reins, project, turns } = setup();
    const before = listSessions({ projectId: project.id });
    await expect(Promise.resolve().then(() => reins.sessions.start("bad", {}))).rejects.toThrow();
    await expect(Promise.resolve().then(() => reins.sessions.start("bad", { parentSessionId: null, modelId: "alone" }))).rejects.toThrow();
    await expect(Promise.resolve().then(() => reins.sessions.send("parent", ""))).rejects.toThrow();
    await expect(Promise.resolve().then(() => reins.sessions.wait("parent", 0))).rejects.toThrow("itself");
    expect(listSessions({ projectId: project.id })).toEqual(before);
    expect(turns).toEqual([]);
  });

  test("a send the session cannot admit is the script's error, and leaves its run alone", async () => {
    const { reins, turns, project } = setup();
    const child = Value.Decode(SessionHandleSchema, await reins.sessions.start("Work", { parentSessionId: null }));
    await admitted(turns, 1);
    createSession("broken", project.id, { agentRuntimeType: "pi", modelProvider: provider(), modelId: "missing" });
    await expect(reins.sessions.send("broken", "not accepted")).rejects.toThrow(`Model not found: ${provider()}/missing`);
    expect(getSession(child.sessionId)?.activity_state).toBe("running");
    turns[0].finish();
    await reins.sessions.wait(child.sessionId, 1000);
    expect(turns).toHaveLength(1);
    expect(transcript("broken")).toEqual([]);
  });

  test("inherits task scope and enforces child depth while independent sessions have no parent", async () => {
    const { project, contextFor, turns } = setup();
    await Bun.spawn(["git", "branch", "task/orchestration"], { cwd: repo.dir }).exited;
    const task = createTask(project.id, "Orchestration", null, "task/orchestration");
    createSession("task-parent", project.id, { agentRuntimeType: "pi", taskId: task.id, modelProvider: provider(), modelId: "fake" });
    const reins = buildApiObject(contextFor("task-parent"));
    const child = Value.Decode(SessionHandleSchema, await reins.sessions.start("Task work", { parentSessionId: "current" }));
    expect(getSession(child.sessionId)).toMatchObject({ task_id: task.id, parent_session_id: "task-parent" });
    await admitted(turns, 1);
    turns[0].finish();
    await reins.sessions.wait(child.sessionId, 1000);

    createSession("level-two", project.id, { agentRuntimeType: "pi", taskId: task.id, parentSessionId: child.sessionId });
    createSession("level-three", project.id, { agentRuntimeType: "pi", taskId: task.id, parentSessionId: "level-two", modelProvider: provider(), modelId: "fake" });
    const deep = buildApiObject(contextFor("level-three"));
    const ids = () => listSessions({ taskId: task.id }).map(session => session.id);
    const before = ids();
    await expect(deep.sessions.start("Too deep", { parentSessionId: "current" })).rejects.toThrow("depth");
    expect(ids()).toEqual(before);
    const independent = Value.Decode(SessionHandleSchema, await deep.sessions.start("Independent work", { parentSessionId: null }));
    expect(getSession(independent.sessionId)).toMatchObject({ task_id: task.id, parent_session_id: null });
    // The first child's report also started a run on its parent.
    const independentTurns = () => turns.filter(turn => turn.sessionId === independent.sessionId);
    for (let i = 0; i < 100 && independentTurns().length === 0; i++) await Bun.sleep(10);
    expect(independentTurns()).toHaveLength(1);
    independentTurns()[0]!.finish();
    await deep.sessions.wait(independent.sessionId, 1000);
  });

  test("starts sessions in another task or scratch, independent unless asked, and waits on any of them", async () => {
    const { reins, project, turns } = setup();
    await Bun.spawn(["git", "branch", "task/elsewhere"], { cwd: repo.dir }).exited;
    const task = createTask(project.id, "Elsewhere", null, "task/elsewhere");

    const independent = Value.Decode(SessionHandleSchema, await reins.sessions.start("Independent", { parentSessionId: null, taskId: task.id }));
    expect(getSession(independent.sessionId)).toMatchObject({ task_id: task.id, parent_session_id: null });
    expect(await reins.sessions.wait(independent.sessionId, 0)).toMatchObject({ sessionId: independent.sessionId });

    const child = Value.Decode(SessionHandleSchema, await reins.sessions.start("Child", { parentSessionId: "current", taskId: task.id }));
    expect(getSession(child.sessionId)).toMatchObject({ task_id: task.id, parent_session_id: "parent" });
    await admitted(turns, 2);
    turns.find(turn => turn.sessionId === child.sessionId)!.finish({ reply: "Done" });
    expect(await reins.sessions.wait(child.sessionId, 1000)).toMatchObject({ status: "completed", result: "Done" });
    await answerUntilIdle(independent.sessionId);
    await answerUntilIdle("parent");
  });

  test("a task session starts scratch sessions with taskId null; tasks of other projects are refused", async () => {
    const { project, contextFor } = setup();
    const task = createTask(project.id, "Caller task", null, "task/caller");
    createSession("task-caller", project.id, { agentRuntimeType: "pi", taskId: task.id, modelProvider: provider(), modelId: "fake" });
    const reins = buildApiObject(contextFor("task-caller"));
    const other = createProject("Other", `${repo.dir}/other`, "main");
    const foreignTask = createTask(other.id, "Foreign", null, "task/foreign");
    const before = listSessions({ projectId: project.id });
    await expect(Promise.resolve().then(() => reins.sessions.start("bad", { parentSessionId: null, taskId: foreignTask.id }))).rejects.toThrow(`Task ${foreignTask.id} is not a task of project ${project.id}`);
    await expect(Promise.resolve().then(() => reins.sessions.start("bad", { parentSessionId: null, taskId: 999_999 }))).rejects.toThrow("Task not found: 999999");
    await expect(Promise.resolve().then(() => reins.sessions.start("bad", { parentSessionId: null, model: { provider: provider(), modelId: "missing" } }))).rejects.toThrow(`Model 'missing' not found for provider '${provider()}'`);
    expect(listSessions({ projectId: project.id })).toEqual(before);

    const scratch = Value.Decode(SessionHandleSchema, await reins.sessions.start("Scratch", { parentSessionId: null, taskId: null }));
    expect(getSession(scratch.sessionId)).toMatchObject({ task_id: null, parent_session_id: null });
    await answerUntilIdle(scratch.sessionId);
  });

  test("starts a child in another project's task at that project's home source, and sends to and waits for it", async () => {
    const { reins, turns } = setup();
    const otherRepo = await createTestRepo();
    const other = createProject("Other", otherRepo.dir, "main");
    const task = createTask(other.id, "Foreign", null, "task/foreign");

    const child = Value.Decode(SessionHandleSchema, await reins.sessions.start("Over there", { parentSessionId: "current", projectId: other.id, taskId: task.id }));

    expect(getSession(child.sessionId)).toMatchObject({
      project_id: other.id, task_id: task.id, source_id: other.default_source_id, parent_session_id: "parent",
    });
    await admitted(turns, 1);
    turns[0].finish({ reply: "first" });
    expect(await reins.sessions.wait(child.sessionId, 1000)).toMatchObject({ status: "completed", result: "first" });
    await answerUntilIdle("parent");
    await reins.sessions.send(child.sessionId, "Again");
    await answerUntilIdle(child.sessionId, "second");
    expect(await reins.sessions.wait(child.sessionId, 1000)).toMatchObject({ status: "completed", result: "second" });
    await answerUntilIdle("parent");
    otherRepo.cleanup();
  });

  test("a session started in another project without a task is a scratch session there", async () => {
    const { project, contextFor } = setup();
    await Bun.spawn(["git", "branch", "task/caller"], { cwd: repo.dir }).exited;
    const callerTask = createTask(project.id, "Caller", null, "task/caller");
    createSession("task-caller", project.id, { agentRuntimeType: "pi", taskId: callerTask.id, modelProvider: provider(), modelId: "fake" });
    const taskApi = buildApiObject(contextFor("task-caller"));
    const other = createProject("Other", `${repo.dir}-other`, "main");

    const started = Value.Decode(SessionHandleSchema, await taskApi.sessions.start("Look", { parentSessionId: null, projectId: other.id }));

    expect(getSession(started.sessionId)).toMatchObject({ project_id: other.id, task_id: null, source_id: other.default_source_id });
    await answerUntilIdle(started.sessionId);
  });

  test("a task that is not of the project named is refused", async () => {
    const { reins, project } = setup();
    const other = createProject("Other", `${repo.dir}-other`, "main");
    const homeTask = createTask(project.id, "Home", null, "task/home");
    const before = listSessions({ projectId: other.id });

    await expect(Promise.resolve().then(() => reins.sessions.start("bad", { parentSessionId: null, projectId: other.id, taskId: homeTask.id })))
      .rejects.toThrow(`Task ${homeTask.id} is not a task of project ${other.id}`);
    expect(listSessions({ projectId: other.id })).toEqual(before);
  });

  test("starting siblings on the active task does not contend for Git's checkout lock", async () => {
    const { project, contextFor } = setup();
    await Bun.spawn(["git", "checkout", "-b", "task/parallel"], { cwd: repo.dir, stderr: "ignore" }).exited;
    const task = createTask(project.id, "Parallel", null, "task/parallel");
    createSession("task-parent", project.id, { agentRuntimeType: "pi", taskId: task.id, modelProvider: provider(), modelId: "fake" });
    const reins = buildApiObject(contextFor("task-parent"));
    // Another agent may be using Git; creating sessions on the already-active branch needs no checkout.
    const lock = join(repo.dir, ".git/index.lock");
    writeFileSync(lock, "held by another operation");
    let siblings: { sessionId: string }[];
    try {
      siblings = await Promise.all(["one", "two"].map(async (prompt) =>
        Value.Decode(SessionHandleSchema, await reins.sessions.start(prompt, { parentSessionId: "current" }))));
    } finally {
      unlinkSync(lock);
    }
    expect(new Set(siblings.map((child) => child.sessionId)).size).toBe(2);
    await Promise.all(siblings.map(child => answerUntilIdle(child.sessionId)));
    await Promise.all(siblings.map((child) => reins.sessions.wait(child.sessionId, 1000)));
  });

  test("returns bounded timeout and already-settled idle, failure and cancellation outcomes", async () => {
    const { reins, turns, project } = setup();
    createSession("empty", project.id, { agentRuntimeType: "pi" });
    persistCanonicalMessages("empty", []);
    expect(await reins.sessions.wait("empty", 0)).toEqual({ sessionId: "empty", status: "idle", result: null, error: null });
    const child = Value.Decode(SessionHandleSchema, await reins.sessions.start("Work", { parentSessionId: null }));
    expect(await reins.sessions.wait(child.sessionId, 5)).toMatchObject({ status: "timeout" });
    await admitted(turns, 1);
    expect(getSession(child.sessionId)?.activity_state).toBe("running");
    turns[0].finish();
    await reins.sessions.wait(child.sessionId, 1000);
    // The run's durable settlement is the authoritative outcome.
    await reins.sessions.send(child.sessionId, "Fail");
    await admitted(turns, 2);
    turns[1].finish({ status: "failed", error: "Authoritative provider failure" });
    expect(await reins.sessions.wait(child.sessionId, 1000)).toMatchObject({
      status: "failed", result: null, error: "Authoritative provider failure",
    });
    await reins.sessions.send(child.sessionId, "Abort");
    await admitted(turns, 3);
    await new Sessions(loopback.state, () => {}).abort(child.sessionId);
    expect(await reins.sessions.wait(child.sessionId, 1000)).toMatchObject({ status: "cancelled", result: null });
    await expect(reins.sessions.wait(child.sessionId, 30_001)).rejects.toThrow("timeoutMs");
  });

  test("execute cancellation interrupts only its wait, not the target session", async () => {
    const { reins, turns, project, state } = setup();
    const child = Value.Decode(SessionHandleSchema, await reins.sessions.start("Work", { parentSessionId: "current" }));
    const controller = new AbortController();
    const tool = reinsTool("execute", { sessionId: "parent", projectId: project.id, state });
    const waiting = executeTool(tool, "wait", { code: `return await reins.sessions.wait(${JSON.stringify(child.sessionId)}, 1000)` }, controller.signal, undefined);
    controller.abort();
    expect((await waiting).details).toMatchObject({ success: false });
    await admitted(turns, 1);
    expect(getSession(child.sessionId)?.activity_state).toBe("running");
    turns[0].finish();
    expect(await reins.sessions.wait(child.sessionId, 1000)).toMatchObject({ status: "completed" });
  });
});

describe("sessions from a script: what it starts and sends is the calling session's", () => {
  useTestDb();
  const repo = useTestRepo();
  const loopback = useLoopbackState();
  const model = useFakeModel();
  const withModel = () => ({ agentRuntimeType: "pi", modelProvider: model.model.provider, modelId: model.model.modelId });
  const apiOf = (sessionId: string) => buildApiObject(scriptContext(loopback.state, { sessionId }));

  test("a send is a steer from the sender to the target's runtime, admitted when it resolves, to any task and project", async () => {
    const project = createProject("Messages", repo.dir);
    createSession("source", project.id, withModel());
    createSession("target", project.id, withModel());
    const other = createProject("Target", `${repo.dir}/other`);
    createSession("stranger", other.id, withModel());
    const reins = apiOf("source");

    expect(await reins.sessions.send("target", "First")).toBeUndefined();
    await reins.sessions.send("stranger", "Also this");

    expect(inputsOf("target")).toEqual([{ role: "reinsInput", content: [{ type: "text", text: "First" }], reinsId: expect.any(String), metadata: { sourceSessionId: "source" }, timestamp: expect.any(Number) }]);
    expect(inputsOf("stranger")).toEqual([expect.objectContaining({ content: [{ type: "text", text: "Also this" }], metadata: { sourceSessionId: "source" } })]);
  });

  test("a child is created on the caller's source and prompted there; waiting on it resolves once it reported to its parent", async () => {
    const project = createProject("Children", repo.dir);
    const caller = createSession("parent", project.id, withModel());
    const reins = apiOf("parent");

    const { sessionId } = Value.Parse(SessionHandleSchema, await reins.sessions.start("Child work", { parentSessionId: "current" }));
    const waiting = reins.sessions.wait(sessionId, 10_000);
    (await model.nextTurn(sessionId)).finish({ reply: "Child result" });

    expect(getSession(sessionId)).toMatchObject({ source_id: caller.source_id, parent_session_id: "parent" });
    expect(await waiting).toEqual({ sessionId, status: "completed", result: "Child result", error: null });
    expect(getSession(sessionId)?.activity_state).toBeNull();
    expect(inputsOf(sessionId)).toEqual([expect.objectContaining({ content: [{ type: "text", text: "Child work" }] })]);
    expect(inputsOf("parent")).toEqual([expect.objectContaining({ content: [{ type: "text", text: "Child result" }], metadata: { sourceSessionId: sessionId } })]);
  });
});

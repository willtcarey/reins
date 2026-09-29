import { describe, expect, test } from "bun:test";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { SessionHandleSchema } from "../../scripting/sessions.js";
import { createProject } from "../../project-store.js";
import { createTask } from "../../task-store.js";
import { createSession, getSession, listSessions, updateActivityState, updateSessionMetadata } from "../session-fixture.js";
import { loadMessages } from "../../messages-store.js";
import { SessionManager } from "../../runtimes/session-manager.js";
import { buildApiObject, searchFunctions, referencedTypes } from "../../scripting/api-registry.js";
import { useTestDb } from "../helpers/test-db.js";
import { useTestRepo } from "../helpers/test-repo.js";
import { createServerState } from "../helpers/server-state.js";
import { useFakeNode } from "../helpers/fake-node.js";
import { persistCanonicalMessages } from "../helpers/canonical-messages.js";
import { executeTool, reinsTool } from "../helpers/execute-tool.js";

const text = (value: string) => [{ type: "text" as const, text: value }];

async function admitted(turns: unknown[], count: number): Promise<void> {
  for (let i = 0; i < 100 && turns.length < count; i++) await Bun.sleep(10);
  expect(turns).toHaveLength(count);
}

describe("api.sessions orchestration", () => {
  useTestDb();
  const repo = useTestRepo();

  function setup() {
    const state = createServerState();
    // Every session runs on the (fake) node.
    const node = useFakeNode(state);
    const project = createProject("Orchestration", repo.dir, "main");
    createSession("parent", project.id, {
      agentRuntimeType: "pi", modelProvider: "test", modelId: "model", thinkingLevel: "high",
    });
    const turns = node.turns;
    const broadcasts: unknown[] = [];
    const broadcast = (message: unknown) => broadcasts.push(message);
    const manager = new SessionManager(state);
    const instanceFor = (sessionId: string) => manager.forSession(sessionId);
    const context = {
      projectId: project.id,
      sessionId: "parent",
      taskId: null,
      broadcast,
      instance: instanceFor("parent"),
    };
    const ops = (sessionId: string) => node.sent.flatMap((command) => command.sessionId === sessionId ? [command.op] : []);
    return { state, node, project, turns, broadcasts, context, instanceFor, ops, api: buildApiObject(context) };
  }

  /** The transcript as the server's replica holds it. */
  const transcript = (sessionId: string, role?: string) => loadMessages(sessionId).filter(message => !role || message.role === role).map(message => message.content);

  test("discovers unread activity and returns persisted status without marking sessions read", async () => {
    const { api } = setup();
    const functions = searchFunctions("unread");
    expect(functions.map((fn) => fn.name)).toContain("sessions.list");
    expect(referencedTypes(functions).map((type) => JSON.stringify(type)).join("\n")).toContain("unread");
    for (const activity of [null, "running", "finished"] as const) {
      updateActivityState("parent", activity);
      const unread = activity === "finished";
      expect(await api.sessions.current()).toMatchObject({ unread, pinned: false, archived: false });
      expect(await api.sessions.get("parent")).toMatchObject({ unread, pinned: false, archived: false });
      expect(await api.sessions.list()).toContainEqual(expect.objectContaining({
        id: "parent", unread, pinned: false, archived: false,
      }));
      expect(getSession("parent")!.activity_state).toBe(activity);
    }
  });

  test("exposes pin and archive state as booleans without leaking persistence timestamps", async () => {
    const { api } = setup();
    updateSessionMetadata("parent", { pinned: true, archived: true });

    const current = await api.sessions.current();
    const fetched = await api.sessions.get("parent");

    expect(current).toMatchObject({ pinned: true, archived: true });
    expect(fetched).toMatchObject({ pinned: true, archived: true });
    expect(current).not.toHaveProperty("pinned_at");
    expect(current).not.toHaveProperty("archived_at");
  });

  test("pins and archives independently through explicit session mutations", async () => {
    const { api } = setup();

    expect(await api.sessions.setPinned("parent", true)).toMatchObject({ pinned: true, archived: false });
    expect(await api.sessions.setArchived("parent", true)).toMatchObject({ pinned: true, archived: true });
    expect(await api.sessions.setArchived("parent", false)).toMatchObject({ pinned: true, archived: false });
    expect(getSession("parent")).toMatchObject({ pinned_at: expect.any(String), archived_at: null });

    const otherProject = createProject("Other organization", `${repo.dir}-organization`, "main");
    createSession("foreign-organization", otherProject.id, { agentRuntimeType: "pi" });
    await expect(Promise.resolve().then(() => api.sessions.setPinned("foreign-organization", true))).rejects.toThrow("scope");
    expect(getSession("foreign-organization")!.pinned_at).toBeNull();
  });

  test("renames and clears a session through an explicit scoped mutation", async () => {
    const { api, broadcasts } = setup();

    expect(await api.sessions.setName("parent", "  Important investigation  ")).toMatchObject({
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

    expect(await api.sessions.setName("parent", null)).toMatchObject({ name: null });
    expect(getSession("parent")!.name).toBeNull();
  });

  test("rejects invalid or foreign-project names without side effects", async () => {
    const { api, broadcasts } = setup();
    updateSessionMetadata("parent", { name: "Original" });

    await expect(Promise.resolve().then(() => api.sessions.setName("parent", "   "))).rejects.toThrow();
    expect(getSession("parent")!.name).toBe("Original");
    expect(broadcasts).toEqual([]);

    const otherProject = createProject("Other naming", `${repo.dir}-naming`, "main");
    createSession("foreign-name", otherProject.id, { agentRuntimeType: "pi" });
    updateSessionMetadata("foreign-name", { name: "Foreign original" });
    await expect(Promise.resolve().then(() => api.sessions.setName("foreign-name", "Not allowed"))).rejects.toThrow("scope");
    expect(getSession("foreign-name")!.name).toBe("Foreign original");
    expect(broadcasts).toEqual([]);
  });

  test("starts immediately with explicit child/title semantics and waits for native settlement", async () => {
    const { api, turns, project } = setup();
    const child = Value.Decode(SessionHandleSchema, await api.sessions.start("Investigate", { parentSessionId: "current", title: "Investigation" }));
    expect(getSession(child.sessionId)).toMatchObject({
      name: "Investigation", parent_session_id: "parent", project_id: project.id,
      model_provider: "test", model_id: "model", thinking_level: "high",
    });
    await admitted(turns, 1);
    expect(turns[0].input).toEqual(text("Investigate"));
    expect(await api.sessions.wait(child.sessionId, 0)).toMatchObject({ status: "timeout" });
    turns[0].finish({ reply: "response 1" });
    expect(await api.sessions.wait(child.sessionId, 1000)).toMatchObject({ status: "completed", result: "response 1" });
    expect(transcript(child.sessionId)).toEqual([text("Investigate"), text("response 1")]);
  });

  test("independent sessions preserve unnamed display defaults and allow model overrides", async () => {
    const { api, turns, project } = setup();
    const session = Value.Decode(SessionHandleSchema, await api.sessions.start("Independent", {
      parentSessionId: null, modelProvider: "test", modelId: "other", thinkingLevel: "minimal",
    }));
    expect(getSession(session.sessionId)).toMatchObject({ name: null, parent_session_id: null, model_id: "other", thinking_level: "minimal" });
    await admitted(turns, 1);
    turns[0].finish();
    await api.sessions.wait(session.sessionId, 1000);
    expect(listSessions({ projectId: project.id }).find((row) => row.id === session.sessionId)?.first_message).toBe("Independent");
  });

  test("delivers to an existing session's node, steers concurrent follow-ups, and resumes after settlement", async () => {
    const fixture = setup();
    const { api, project, turns } = fixture;
    createSession("existing", project.id, { agentRuntimeType: "pi", modelProvider: "test", modelId: "model" });
    persistCanonicalMessages("existing", [{ role: "assistant", content: text("earlier"), timestamp: 1 }]);
    await Promise.all([api.sessions.send("existing", "one"), api.sessions.send("existing", "two")]);
    await admitted(turns, 1);
    expect(fixture.ops("existing")).toEqual(["session.steer", "session.steer"]);
    expect(await api.sessions.wait("existing", 0)).toMatchObject({ status: "timeout" });
    turns[0].finish({ reply: "response 3" });
    expect(await api.sessions.wait("existing", 1000)).toMatchObject({ status: "completed", result: "response 3" });
    expect(transcript("existing", "user")).toEqual([text("one"), text("two")]);
    await api.sessions.send("existing", "resume");
    await admitted(turns, 2);
    turns[1].finish({ reply: "response 5" });
    expect(await api.sessions.wait("existing", 1000)).toMatchObject({ status: "completed", result: "response 5" });
    expect(fixture.ops("existing")).toEqual(["session.steer", "session.steer", "session.steer"]);
  });

  test("validates parent, model, message, scope and self-wait before side effects", async () => {
    const { api, project, turns } = setup();
    const before = listSessions({ projectId: project.id });
    await expect(Promise.resolve().then(() => api.sessions.start("bad", {}))).rejects.toThrow();
    await expect(Promise.resolve().then(() => api.sessions.start("bad", { parentSessionId: null, modelId: "alone" }))).rejects.toThrow();
    await expect(Promise.resolve().then(() => api.sessions.send("parent", ""))).rejects.toThrow();
    await expect(Promise.resolve().then(() => api.sessions.wait("parent", 0))).rejects.toThrow("itself");
    const other = createProject("Other", `${repo.dir}/other`, "main");
    createSession("foreign", other.id, { agentRuntimeType: "pi" });
    await expect(Promise.resolve().then(() => api.sessions.send("foreign", "bad"))).rejects.toThrow("project");
    expect(listSessions({ projectId: project.id })).toEqual(before);
    expect(turns).toEqual([]);
  });

  test("a steer the node rejects fails without restarting or deferring the message", async () => {
    const { api, turns, node } = setup();
    const child = Value.Decode(SessionHandleSchema, await api.sessions.start("Work", { parentSessionId: null }));
    await admitted(turns, 1);
    node.reject("session.steer", "Steering unsupported");
    await api.sessions.send(child.sessionId, "not accepted");
    await Bun.sleep(20);
    expect(getSession(child.sessionId)?.activity_state).toBe("running");
    expect(node.sent.some((command) => command.op === "session.abort")).toBe(false);
    turns[0].finish();
    await api.sessions.wait(child.sessionId, 1000);
    expect(turns).toHaveLength(1);
    expect(transcript(child.sessionId, "user")).toEqual([text("Work")]);
  });

  test("inherits task scope and enforces child depth while independent sessions have no parent", async () => {
    const { project, context, instanceFor, turns } = setup();
    await Bun.spawn(["git", "branch", "task/orchestration"], { cwd: repo.dir }).exited;
    const task = createTask(project.id, "Orchestration", null, "task/orchestration");
    createSession("task-parent", project.id, { agentRuntimeType: "pi", taskId: task.id });
    const taskContext = {
      ...context,
      sessionId: "task-parent",
      taskId: task.id,
      instance: instanceFor("task-parent"),
    };
    const api = buildApiObject(taskContext);
    const child = Value.Decode(SessionHandleSchema, await api.sessions.start("Task work", { parentSessionId: "current" }));
    expect(getSession(child.sessionId)).toMatchObject({ task_id: task.id, parent_session_id: "task-parent" });
    await admitted(turns, 1);
    turns[0].finish();
    await api.sessions.wait(child.sessionId, 1000);

    createSession("level-two", project.id, { agentRuntimeType: "pi", taskId: task.id, parentSessionId: child.sessionId });
    createSession("level-three", project.id, { agentRuntimeType: "pi", taskId: task.id, parentSessionId: "level-two" });
    const deep = buildApiObject({
      ...taskContext,
      sessionId: "level-three",
      instance: instanceFor("level-three"),
    });
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

  test("starting siblings on the active task does not contend for Git's checkout lock", async () => {
    const { project, context, instanceFor, turns } = setup();
    await Bun.spawn(["git", "checkout", "-b", "task/parallel"], { cwd: repo.dir, stderr: "ignore" }).exited;
    const task = createTask(project.id, "Parallel", null, "task/parallel");
    createSession("task-parent", project.id, { agentRuntimeType: "pi", taskId: task.id });
    const api = buildApiObject({
      ...context,
      sessionId: "task-parent",
      taskId: task.id,
      instance: instanceFor("task-parent"),
    });
    // Another agent may be using Git; creating sessions on the already-active branch needs no checkout.
    const lock = join(repo.dir, ".git/index.lock");
    writeFileSync(lock, "held by another operation");
    let siblings: { sessionId: string }[];
    try {
      siblings = await Promise.all(["one", "two"].map(async (prompt) =>
        Value.Decode(SessionHandleSchema, await api.sessions.start(prompt, { parentSessionId: "current" }))));
    } finally {
      unlinkSync(lock);
    }
    expect(new Set(siblings.map((child) => child.sessionId)).size).toBe(2);
    await admitted(turns, 2);
    for (const turn of turns) turn.finish();
    await Promise.all(siblings.map((child) => api.sessions.wait(child.sessionId, 1000)));
  });

  test("returns bounded timeout and already-settled idle, failure and cancellation outcomes", async () => {
    const { api, turns, project } = setup();
    createSession("empty", project.id, { agentRuntimeType: "pi" });
    persistCanonicalMessages("empty", []);
    expect(await api.sessions.wait("empty", 0)).toEqual({ sessionId: "empty", status: "idle", result: null, error: null });
    const child = Value.Decode(SessionHandleSchema, await api.sessions.start("Work", { parentSessionId: null }));
    expect(await api.sessions.wait(child.sessionId, 5)).toMatchObject({ status: "timeout" });
    await admitted(turns, 1);
    expect(getSession(child.sessionId)?.activity_state).toBe("running");
    turns[0].finish();
    await api.sessions.wait(child.sessionId, 1000);
    // The node's durable settlement is the authoritative outcome.
    await api.sessions.send(child.sessionId, "Fail");
    await admitted(turns, 2);
    turns[1].finish({ status: "failed", error: "Authoritative provider failure" });
    expect(await api.sessions.wait(child.sessionId, 1000)).toMatchObject({
      status: "failed", result: null, error: "Authoritative provider failure",
    });
    await api.sessions.send(child.sessionId, "Abort");
    await admitted(turns, 3);
    turns[2].finish({ status: "aborted", error: "Aborted" });
    expect(await api.sessions.wait(child.sessionId, 1000)).toMatchObject({ status: "cancelled", result: null, error: "Aborted" });
    await expect(api.sessions.wait(child.sessionId, 30_001)).rejects.toThrow("timeoutMs");
  });

  test("execute cancellation interrupts only its wait, not the target session", async () => {
    const { api, turns, context } = setup();
    const child = Value.Decode(SessionHandleSchema, await api.sessions.start("Work", { parentSessionId: "current" }));
    const controller = new AbortController();
    const tool = reinsTool("execute", context);
    const waiting = executeTool(tool, "wait", { code: `return await api.sessions.wait(${JSON.stringify(child.sessionId)}, 1000)` }, controller.signal, undefined);
    controller.abort();
    expect((await waiting).details).toMatchObject({ success: false });
    await admitted(turns, 1);
    expect(getSession(child.sessionId)?.activity_state).toBe("running");
    turns[0].finish();
    expect(await api.sessions.wait(child.sessionId, 1000)).toMatchObject({ status: "completed" });
  });
});

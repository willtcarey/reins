import { describe, expect, test } from "bun:test";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { SessionHandleSchema } from "../../scripting/sessions.js";
import { createProject } from "../../project-store.js";
import { createTask } from "../../task-store.js";
import { createSession, getSession, listSessions, updateActivityState } from "../../session-store.js";
import { loadMessages, type RuntimeMessage } from "../../messages-store.js";
import { createNewSession, ensureSessionOpen } from "../../runtimes/sessions-manager.js";
import { registerRuntimeAdapter } from "../../runtimes/registry.js";
import { buildApiObject, searchFunctions, referencedTypes } from "../../scripting/api-registry.js";
import { createExecuteTool } from "../../tools/execute.js";
import { useTestDb } from "../helpers/test-db.js";
import { useTestRepo } from "../helpers/test-repo.js";
import { createServerState } from "../helpers/server-state.js";
import { createRuntimeStub } from "../helpers/test-runtime-stub.js";
import { persistCanonicalMessages } from "../helpers/canonical-messages.js";
import { executeTool } from "../helpers/execute-tool.js";

const text = (value: string) => [{ type: "text" as const, text: value }];

describe("api.sessions orchestration", () => {
  useTestDb();
  const repo = useTestRepo();

  function setup() {
    const state = createServerState();
    const project = createProject("Orchestration", repo.dir, "main");
    createSession("parent", project.id, {
      agentRuntimeType: "pi", modelProvider: "test", modelId: "model", thinkingLevel: "high",
    });
    // Scripting runs inside an already-open caller; reports steer that caller.
    state.sessions.set("parent", { id: "parent", runtime: createRuntimeStub({ isStreaming: true }).runtime, lastActivity: Date.now() });
    const turns: { finish: () => void; input: unknown; sessionId: string }[] = [];
    let created = 0;
    registerRuntimeAdapter({
      runtimeType: "pi", listModels: async () => [], ask: async () => "",
      createRuntime: async ({ sessionId }) => {
        created++;
        const stub = createRuntimeStub();
        const messages: RuntimeMessage[] = loadMessages(sessionId);
        stub.runtime.getMessages = async () => messages;
        let completion = Promise.resolve();
        let busy = false;
        stub.runtime.prompt = async (content) => {
          busy = true;
          messages.push({ role: "user", content: content.filter((block) => block.type === "text"), timestamp: messages.length + 1 });
          const messageId = `entry-${messages.length}`;
          completion = (async () => {
            await new Promise<void>((resolve) => turns.push({ finish: resolve, input: content, sessionId }));
            const response: RuntimeMessage = { role: "assistant", content: text(`response ${messages.length}`), timestamp: messages.length + 1 };
            messages.push(response);
            stub.emit({ type: "agent_end", messages });
          })().finally(() => { busy = false; });
          return { messageId };
        };
        stub.runtime.steer = async (content) => {
          if (!busy) {
            await stub.runtime.prompt(content);
            return;
          }
          messages.push({ role: "user", content: content.filter((block) => block.type === "text"), timestamp: messages.length + 1 });
        };
        stub.runtime.waitForIdle = async () => { await completion; };
        stub.runtime.isStreaming = () => busy;
        return stub.runtime;
      },
    });
    const lifecycle = {
      createSession: (projectId: number, projectDir: string, options?: Parameters<typeof createNewSession>[3]) => createNewSession(state, projectId, projectDir, options),
      openSession: (sessionId: string) => ensureSessionOpen(state, sessionId),
    };
    const context = { projectId: project.id, sessionId: "parent", taskId: null, sessions: state.sessions, broadcast: () => {}, ...lifecycle };
    return { state, project, turns, context, api: buildApiObject(context), get created() { return created; } };
  }

  test("discovers unread activity and returns persisted status without marking sessions read", async () => {
    const { api } = setup();
    const functions = searchFunctions("unread");
    expect(functions.map((fn) => fn.name)).toContain("sessions.list");
    expect(referencedTypes(functions).map((type) => JSON.stringify(type)).join("\n")).toContain("unread");
    for (const activity of [null, "running", "finished"] as const) {
      updateActivityState("parent", activity);
      const unread = activity === "finished";
      expect(await api.sessions.current()).toMatchObject({ unread });
      expect(await api.sessions.get("parent")).toMatchObject({ unread });
      expect(await api.sessions.list()).toContainEqual(expect.objectContaining({ id: "parent", unread }));
      expect(getSession("parent")!.activity_state).toBe(activity);
    }
  });

  test("starts immediately with explicit child/title semantics and waits for native settlement", async () => {
    const { api, turns, state, project } = setup();
    const child = Value.Decode(SessionHandleSchema, await api.sessions.start("Investigate", { parentSessionId: "current", title: "Investigation" }));
    expect(getSession(child.sessionId)).toMatchObject({
      name: "Investigation", parent_session_id: "parent", project_id: project.id,
      model_provider: "test", model_id: "model", thinking_level: "high",
    });
    expect(turns[0].input).toEqual(text("Investigate"));
    expect(await api.sessions.wait(child.sessionId, 0)).toMatchObject({ status: "timeout" });
    turns[0].finish();
    expect(await api.sessions.wait(child.sessionId, 1000)).toMatchObject({ status: "completed", result: "response 1" });
    expect((await state.sessions.get(child.sessionId)!.runtime.getMessages()).map((message) => message.content)).toEqual([text("Investigate"), text("response 1")]);
    expect(state.sessions.has(child.sessionId)).toBe(true);
  });

  test("independent sessions preserve unnamed display defaults and allow model overrides", async () => {
    const { api, turns, project } = setup();
    const session = Value.Decode(SessionHandleSchema, await api.sessions.start("Independent", {
      parentSessionId: null, modelProvider: "test", modelId: "other", thinkingLevel: "minimal",
    }));
    expect(getSession(session.sessionId)).toMatchObject({ name: null, parent_session_id: null, model_id: "other", thinking_level: "minimal" });
    turns[0].finish();
    await api.sessions.wait(session.sessionId, 1000);
    expect(listSessions({ projectId: project.id }).find((row) => row.id === session.sessionId)?.first_message).toBeNull();
  });

  test("reopens once, steers concurrent follow-ups, and resumes after settlement", async () => {
    const fixture = setup();
    const { api, project, turns } = fixture;
    createSession("existing", project.id, { agentRuntimeType: "pi", modelProvider: "test", modelId: "model" });
    persistCanonicalMessages("existing", [{ role: "assistant", content: text("earlier"), timestamp: 1 }]);
    await Promise.all([api.sessions.send("existing", "one"), api.sessions.send("existing", "two")]);
    expect(fixture.created).toBe(1);
    expect(turns).toHaveLength(1);
    expect(await api.sessions.wait("existing", 0)).toMatchObject({ status: "timeout" });
    turns[0].finish();
    expect(await api.sessions.wait("existing", 1000)).toMatchObject({ status: "completed", result: "response 3" });
    expect((await fixture.state.sessions.get("existing")!.runtime.getMessages()).filter((message) => message.role === "user").map((message) => message.content)).toEqual([text("one"), text("two")]);
    await api.sessions.send("existing", "resume");
    expect(turns).toHaveLength(2);
    turns[1].finish();
    expect(await api.sessions.wait("existing", 1000)).toMatchObject({ status: "completed", result: "response 5" });
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
    await expect(Promise.resolve().then(() => api.sessions.send("foreign", "bad"))).rejects.toThrow("scope");
    expect(listSessions({ projectId: project.id })).toEqual(before);
    expect(turns).toEqual([]);
  });

  test("unsupported busy steering reports failure without restarting or deferring the message", async () => {
    const { api, turns, state } = setup();
    const child = Value.Decode(SessionHandleSchema, await api.sessions.start("Work", { parentSessionId: null }));
    const runtime = state.sessions.get(child.sessionId)!.runtime;
    let aborted = false;
    runtime.abort = async () => { aborted = true; };
    runtime.steer = async () => { throw new Error("Steering unsupported"); };
    await expect(api.sessions.send(child.sessionId, "not accepted")).rejects.toThrow("Steering unsupported");
    expect(runtime.isStreaming()).toBe(true);
    expect(aborted).toBe(false);
    turns[0].finish();
    await api.sessions.wait(child.sessionId, 1000);
    expect(turns).toHaveLength(1);
    expect((await state.sessions.get(child.sessionId)!.runtime.getMessages()).filter((message) => message.role === "user").map((message) => message.content)).toEqual([text("Work")]);
  });

  test("inherits task scope and enforces child depth while independent sessions have no parent", async () => {
    const { project, context, turns } = setup();
    await Bun.spawn(["git", "branch", "task/orchestration"], { cwd: repo.dir }).exited;
    const task = createTask(project.id, "Orchestration", null, "task/orchestration");
    createSession("task-parent", project.id, { agentRuntimeType: "pi", taskId: task.id });
    context.sessions.set("task-parent", { id: "task-parent", runtime: createRuntimeStub({ isStreaming: true }).runtime, lastActivity: Date.now() });
    const api = buildApiObject({ ...context, sessionId: "task-parent", taskId: task.id });
    const child = Value.Decode(SessionHandleSchema, await api.sessions.start("Task work", { parentSessionId: "current" }));
    expect(getSession(child.sessionId)).toMatchObject({ task_id: task.id, parent_session_id: "task-parent" });
    turns[0].finish();
    await api.sessions.wait(child.sessionId, 1000);

    createSession("level-two", project.id, { agentRuntimeType: "pi", taskId: task.id, parentSessionId: child.sessionId });
    createSession("level-three", project.id, { agentRuntimeType: "pi", taskId: task.id, parentSessionId: "level-two" });
    const deep = buildApiObject({ ...context, sessionId: "level-three", taskId: task.id });
    const before = listSessions({ taskId: task.id });
    await expect(deep.sessions.start("Too deep", { parentSessionId: "current" })).rejects.toThrow("depth");
    expect(listSessions({ taskId: task.id })).toEqual(before);
    const independent = Value.Decode(SessionHandleSchema, await deep.sessions.start("Independent work", { parentSessionId: null }));
    expect(getSession(independent.sessionId)).toMatchObject({ task_id: task.id, parent_session_id: null });
    turns[1].finish();
    await deep.sessions.wait(independent.sessionId, 1000);
  });

  test("starting siblings on the active task does not contend for Git's checkout lock", async () => {
    const { project, context, turns } = setup();
    await Bun.spawn(["git", "checkout", "-b", "task/parallel"], { cwd: repo.dir, stderr: "ignore" }).exited;
    const task = createTask(project.id, "Parallel", null, "task/parallel");
    createSession("task-parent", project.id, { agentRuntimeType: "pi", taskId: task.id });
    context.sessions.set("task-parent", { id: "task-parent", runtime: createRuntimeStub({ isStreaming: true }).runtime, lastActivity: Date.now() });
    const api = buildApiObject({ ...context, sessionId: "task-parent", taskId: task.id });
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
    for (const turn of turns) turn.finish();
    await Promise.all(siblings.map((child) => api.sessions.wait(child.sessionId, 1000)));
  });

  test("returns bounded timeout and already-settled idle, failure and cancellation outcomes", async () => {
    const { api, turns, state, project } = setup();
    createSession("empty", project.id, { agentRuntimeType: "pi" });
    persistCanonicalMessages("empty", []);
    expect(await api.sessions.wait("empty", 0)).toEqual({ sessionId: "empty", status: "idle", result: null, error: null });
    const child = Value.Decode(SessionHandleSchema, await api.sessions.start("Work", { parentSessionId: null }));
    expect(await api.sessions.wait(child.sessionId, 5)).toMatchObject({ status: "timeout" });
    expect(state.sessions.get(child.sessionId)!.runtime.isStreaming()).toBe(true);
    turns[0].finish();
    await api.sessions.wait(child.sessionId, 1000);
    const runtime = state.sessions.get(child.sessionId)!.runtime;
    runtime.getLastRunOutcome = async () => ({
      runId: "run-failed",
      status: "failed",
      error: { code: "provider_error", message: "Authoritative provider failure" },
    });
    expect(await api.sessions.wait(child.sessionId, 0)).toMatchObject({
      status: "failed", result: null, error: "Authoritative provider failure",
    });
    runtime.waitForIdle = async () => { throw new Error("Provider failed"); };
    expect(await api.sessions.wait(child.sessionId, 0)).toMatchObject({ status: "failed", result: null, error: "Provider failed" });
    runtime.waitForIdle = async () => { throw new DOMException("Aborted", "AbortError"); };
    expect(await api.sessions.wait(child.sessionId, 0)).toMatchObject({ status: "cancelled", result: null, error: "Aborted" });
    await expect(api.sessions.wait(child.sessionId, 30_001)).rejects.toThrow("timeoutMs");
  });

  test("execute cancellation interrupts only its wait, not the target session", async () => {
    const { api, turns, context, state } = setup();
    const child = Value.Decode(SessionHandleSchema, await api.sessions.start("Work", { parentSessionId: "current" }));
    const controller = new AbortController();
    const tool = createExecuteTool(context);
    const waiting = executeTool(tool, "wait", { code: `return await api.sessions.wait(${JSON.stringify(child.sessionId)}, 1000)` }, controller.signal, undefined);
    controller.abort();
    expect((await waiting).details).toMatchObject({ success: false });
    expect(state.sessions.get(child.sessionId)!.runtime.isStreaming()).toBe(true);
    turns[0].finish();
    expect(await api.sessions.wait(child.sessionId, 1000)).toMatchObject({ status: "completed" });
  });
});

import { describe, expect, test } from "bun:test";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { SessionHandleSchema } from "../../scripting/sessions.js";
import { createProject } from "../../project-store.js";
import { createTask } from "../../task-store.js";
import { createSession, getSession, listSessions, updateActivityState } from "../../session-store.js";
import { loadMessages, persistMessages, type RuntimeMessage } from "../../messages-store.js";
import { createNewSession, ensureSessionOpen } from "../../runtimes/sessions-manager.js";
import { registerRuntimeAdapter } from "../../runtimes/registry.js";
import { buildApiObject, searchFunctions, referencedTypes } from "../../scripting/api-registry.js";
import { createExecuteTool } from "../../tools/execute.js";
import { useTestDb } from "../helpers/test-db.js";
import { useTestRepo } from "../helpers/test-repo.js";
import { createServerState } from "../helpers/server-state.js";
import { createRuntimeStub } from "../helpers/test-runtime-stub.js";
import { createStrictExtensionContext } from "../helpers/test-pi.js";

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
    const turns: { finish: () => void; input: unknown; sessionId: string }[] = [];
    let created = 0;
    registerRuntimeAdapter({
      runtimeType: "pi", listModels: async () => [], ask: async () => "",
      createRuntime: async ({ sessionId }) => {
        created++;
        const stub = createRuntimeStub();
        const messages: RuntimeMessage[] = loadMessages(sessionId);
        stub.runtime.getMessages = async () => messages;
        stub.runtime.prompt = async (content) => {
          messages.push({ role: "user", content: content.filter((block) => block.type === "text"), timestamp: messages.length + 1 });
          await new Promise<void>((resolve) => turns.push({ finish: resolve, input: content, sessionId }));
          const response: RuntimeMessage = { role: "assistant", content: text(`response ${messages.length}`), timestamp: messages.length + 1 };
          messages.push(response);
          stub.emit({ type: "agent_end", messages });
        };
        let completion = Promise.resolve();
        let busy = 0;
        stub.runtime.queue = async (content) => {
          busy++;
          completion = completion.then(() => stub.runtime.prompt(content)).finally(() => { busy--; });
        };
        stub.runtime.waitForIdle = async () => { do { await completion; } while (stub.runtime.isStreaming()); };
        stub.runtime.isStreaming = () => busy > 0;
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

  test("starts immediately with explicit child/title semantics and persists raw messages before settlement", async () => {
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
    expect(loadMessages(child.sessionId).map((message) => message.content)).toEqual([text("Investigate"), text("response 1")]);
    expect(state.sessions.has(child.sessionId)).toBe(true);
    await state.sessions.get(child.sessionId)!.runtime.close();
    state.sessions.delete(child.sessionId);
    // Waiting on a closed session reads history without materializing an LLM runtime.
    expect(await api.sessions.wait(child.sessionId, 0)).toMatchObject({ status: "completed", result: "response 1" });
    expect(state.sessions.has(child.sessionId)).toBe(false);
  });

  test("independent sessions preserve unnamed display defaults and allow model overrides", async () => {
    const { api, turns, project } = setup();
    const session = Value.Decode(SessionHandleSchema, await api.sessions.start("Independent", {
      parentSessionId: null, modelProvider: "test", modelId: "other", thinkingLevel: "minimal",
    }));
    expect(getSession(session.sessionId)).toMatchObject({ name: null, parent_session_id: null, model_id: "other", thinking_level: "minimal" });
    turns[0].finish();
    await api.sessions.wait(session.sessionId, 1000);
    expect(listSessions({ projectId: project.id }).find((row) => row.id === session.sessionId)?.first_message).toBe("Independent");
  });

  test("reopens a persisted session once for concurrent sends and waits for the entire queue", async () => {
    const fixture = setup();
    const { api, project, turns } = fixture;
    createSession("existing", project.id, { agentRuntimeType: "pi", modelProvider: "test", modelId: "model" });
    persistMessages("existing", [{ role: "assistant", content: text("earlier"), timestamp: 1 }]);
    await Promise.all([api.sessions.send("existing", "one", "steer"), api.sessions.send("existing", "two", "queue")]);
    expect(fixture.created).toBe(1);
    const waiting = api.sessions.wait("existing", 1000);
    turns[0].finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await api.sessions.wait("existing", 0)).toMatchObject({ status: "timeout" });
    turns[1].finish();
    expect(await waiting).toMatchObject({ status: "completed", result: "response 4" });
  });

  test("validates parent, model, delivery mode, scope and self-wait before side effects", async () => {
    const { api, project, turns } = setup();
    const before = listSessions({ projectId: project.id });
    await expect(Promise.resolve().then(() => api.sessions.start("bad", {}))).rejects.toThrow();
    await expect(Promise.resolve().then(() => api.sessions.start("bad", { parentSessionId: null, modelId: "alone" }))).rejects.toThrow();
    await expect(Promise.resolve().then(() => api.sessions.send("parent", "bad", "other"))).rejects.toThrow();
    await expect(Promise.resolve().then(() => api.sessions.wait("parent", 0))).rejects.toThrow("itself");
    const other = createProject("Other", `${repo.dir}/other`, "main");
    createSession("foreign", other.id, { agentRuntimeType: "pi" });
    await expect(Promise.resolve().then(() => api.sessions.send("foreign", "bad", "queue"))).rejects.toThrow("scope");
    expect(listSessions({ projectId: project.id })).toEqual(before);
    expect(turns).toEqual([]);
  });

  test("inherits task scope and enforces child depth while independent sessions have no parent", async () => {
    const { project, context, turns } = setup();
    await Bun.spawn(["git", "branch", "task/orchestration"], { cwd: repo.dir }).exited;
    const task = createTask(project.id, "Orchestration", null, "task/orchestration");
    createSession("task-parent", project.id, { agentRuntimeType: "pi", taskId: task.id });
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
    expect(await api.sessions.wait("empty", 0)).toEqual({ sessionId: "empty", status: "idle", result: null, error: null });
    const child = Value.Decode(SessionHandleSchema, await api.sessions.start("Work", { parentSessionId: null }));
    expect(await api.sessions.wait(child.sessionId, 5)).toMatchObject({ status: "timeout" });
    expect(state.sessions.get(child.sessionId)!.runtime.isStreaming()).toBe(true);
    turns[0].finish();
    await api.sessions.wait(child.sessionId, 1000);
    const runtime = state.sessions.get(child.sessionId)!.runtime;
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
    const waiting = tool.execute("wait", { code: `return await api.sessions.wait(${JSON.stringify(child.sessionId)}, 1000)` }, controller.signal, undefined, createStrictExtensionContext());
    controller.abort();
    expect((await waiting).details).toMatchObject({ success: false });
    expect(state.sessions.get(child.sessionId)!.runtime.isStreaming()).toBe(true);
    turns[0].finish();
    expect(await api.sessions.wait(child.sessionId, 1000)).toMatchObject({ status: "completed" });
  });
});

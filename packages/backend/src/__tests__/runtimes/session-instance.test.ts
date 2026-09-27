import { describe, expect, test } from "bun:test";
import { getDb } from "../../db.js";
import { SessionInstance } from "../../runtimes/session-instance.js";
import { SessionManager } from "../../runtimes/session-manager.js";
import { createProject } from "../../project-store.js";
import { createSession, getSession } from "../session-fixture.js";
import { useTestDb } from "../helpers/test-db.js";
import { createRuntimeStub } from "../helpers/test-runtime-stub.js";
import { createServerState } from "../helpers/server-state.js";
import { persistCanonicalMessages } from "../helpers/canonical-messages.js";
import { admitInput, createProvisionedNodeSession, queuePrompt } from "../helpers/node-session.js";
import { nodeSessionReports } from "../../runtimes/node-session-events.js";
import { claimCommand, deleteFailedCommand, settleCommand } from "../../node-command-store.js";

const reply = (text: string) => ({ role: "assistant", content: [{ type: "text" as const, text }], timestamp: 2 });
const settled = (runId: string, status: "completed" | "failed" | "aborted", error?: string) => ({
  sessionId: "node", runId, status, ...(error ? { error: { message: error } } : {}),
  metadata: { model: null, thinkingLevel: null }, reply: null,
});

describe("SessionInstance", () => {
  useTestDb();

  test("delivers addressed messages through native steering without duplicate AgentHarness broadcast", async () => {
    const project = createProject("Messages", "/tmp/messages-test");
    createSession("source", project.id, { agentRuntimeType: "pi" });
    createSession("target", project.id, { agentRuntimeType: "pi" });
    const stub = createRuntimeStub();
    const admission = Promise.withResolvers<void>();
    stub.runtime.steer = async (content, options) => {
      await admission.promise;
      stub.steerCalls.push(content);
      stub.steerOptions.push(options);
    };
    stub.runtime.isStreaming = () => { throw new Error("activity must not choose delivery"); };
    const broadcasts: unknown[] = [];
    const state = createServerState();
    state.sessions.set("target", { id: "target", runtime: stub.runtime, lastActivity: 0 });
    const manager = new SessionManager(state);
    Object.defineProperty(manager, "broadcast", { value: (event: unknown) => { broadcasts.push(event); } });
    const instance = new SessionInstance(manager, "source");

    const sending = instance.send("target", "First");
    await Bun.sleep(0);
    expect(broadcasts).toEqual([]);
    admission.resolve();
    expect(await sending).toEqual({ sessionId: "target" });
    expect(stub.promptCalls).toEqual([]);
    expect(stub.steerCalls).toEqual([[{ type: "text", text: "First" }]]);
    expect(stub.steerOptions).toEqual([{
      reinsId: expect.any(String),
      metadata: { sourceSessionId: "source" },
    }]);
    expect(broadcasts).toEqual([]);
  });

  test("sends to another task's session in the same project", async () => {
    const project = createProject("Cross-task delivery", "/tmp/cross-task-delivery");
    createSession("source", project.id, { agentRuntimeType: "pi" });
    const task = getDb().query<{ id: number }, [number, string, string]>(
      "INSERT INTO tasks (project_id, title, branch_name, status, created_at, updated_at) VALUES (?, ?, ?, 'open', datetime('now'), datetime('now')) RETURNING id",
    ).get(project.id, "Other task", "task/other");
    if (!task) throw new Error("Expected task");
    createSession("target", project.id, { agentRuntimeType: "pi", taskId: task.id });
    const stub = createRuntimeStub();
    const state = createServerState();
    state.sessions.set("target", { id: "target", runtime: stub.runtime, lastActivity: 0 });

    await new SessionInstance(new SessionManager(state), "source").send("target", "Do not break mobile");

    expect(stub.steerCalls).toEqual([[{ type: "text", text: "Do not break mobile" }]]);
    expect(stub.steerOptions).toEqual([{ reinsId: expect.any(String), metadata: { sourceSessionId: "source" } }]);
  });

  test("rejects sending to a session in another project", async () => {
    const sourceProject = createProject("Source", "/tmp/send-source");
    const targetProject = createProject("Target", "/tmp/send-target");
    createSession("source", sourceProject.id, { agentRuntimeType: "pi" });
    createSession("target", targetProject.id, { agentRuntimeType: "pi" });
    const stub = createRuntimeStub();
    const state = createServerState();
    state.sessions.set("target", { id: "target", runtime: stub.runtime, lastActivity: 0 });

    await expect(new SessionInstance(new SessionManager(state), "source").send("target", "Nope")).rejects.toThrow();
    expect(stub.steerCalls).toEqual([]);
  });

  test("updates activity and metadata without rewriting canonical entries", () => {
    const project = createProject("Lifecycle", "/tmp/lifecycle");
    createSession("session", project.id, { agentRuntimeType: "pi" });
    getDb().query(
      `INSERT INTO session_messages (session_id, seq, harness_id, role, message_json, created_at)
       VALUES ('session', 0, 'entry-1', 'assistant', ?, '2026-01-01T00:00:00.000Z')`,
    ).run(JSON.stringify({ type: "message", timestamp: 1, message: { role: "assistant", content: [{ type: "text", text: "canonical" }], stopReason: "stop", timestamp: 1 } }));
    const original = getDb().query<{ message_json: string }, []>("SELECT message_json FROM session_messages").get()!.message_json;
    const stub = createRuntimeStub({
      messages: [{ role: "assistant", content: [{ type: "text", text: "snapshot must not be stored" }] }],
    });
    stub.runtime.getSessionMetadata = () => ({ model: { provider: "faux", modelId: "model" }, thinkingLevel: "high" });
    const manager = new SessionManager(createServerState());
    const instance = new SessionInstance(manager, "session");

    instance.started("run-1");
    instance.settled(stub.runtime, { runId: "run-1", status: "completed" });

    expect(stub.getMessagesCalls).toBe(0);
    expect(getDb().query<{ message_json: string }, []>("SELECT message_json FROM session_messages").get()!.message_json).toBe(original);
    expect(getSession("session")).toMatchObject({ activity_state: "finished", model_provider: "faux", model_id: "model", thinking_level: "high" });
  });

  test("clears child activity only after its authoritative outcome is admitted to the parent", async () => {
    const project = createProject("Reporter", "/tmp/reporter-test");
    createSession("parent", project.id, { agentRuntimeType: "pi" });
    createSession("child", project.id, { agentRuntimeType: "pi", parentSessionId: "parent" });
    const parent = createRuntimeStub();
    const child = createRuntimeStub({ messages: [{ role: "assistant", content: [{ type: "text", text: "stale success" }] }] });
    const activity: string[] = [];
    const admission = Promise.withResolvers<void>();
    const originalSteer = parent.runtime.steer;
    parent.runtime.steer = async (content, options) => {
      await admission.promise;
      await originalSteer(content, options);
    };
    const state = createServerState();
    state.sessions.set("parent", { id: "parent", runtime: parent.runtime, lastActivity: 0 });
    const manager = new SessionManager(state);
    Object.defineProperty(manager, "broadcast", { value: (event: { type: string }) => {
      if (event.type !== "session_updated") return;
      const current = getSession("child")?.activity_state ?? "null";
      activity.push(current);
    } });
    const instance = new SessionInstance(manager, "child");

    instance.started("run-1");
    instance.settled(child.runtime, {
      runId: "run-1",
      status: "failed",
      error: { code: "provider_error", message: "Provider unavailable" },
    });
    await Bun.sleep(0);

    expect(getSession("child")?.activity_state).toBeNull();
    expect(activity).toEqual(["running", "null"]);

    admission.resolve();
    for (let i = 0; i < 100 && parent.steerCalls.length === 0; i++) await Bun.sleep(10);

    expect(activity).toEqual(["running", "null"]);
    expect(parent.steerCalls).toHaveLength(1);
    const notification = parent.steerCalls[0]?.find((block) => block.type === "text")?.text;
    expect(notification).toBe("Session failed: Provider unavailable");
    expect(notification).not.toContain("stale success");
    expect(parent.steerOptions).toEqual([{
      reinsId: expect.any(String),
      metadata: { sourceSessionId: "child" },
    }]);
  });

  test("does not clear newer child activity when an earlier report finishes delivery", async () => {
    const project = createProject("Overlapping reporter", "/tmp/overlapping-reporter-test");
    createSession("parent", project.id, { agentRuntimeType: "pi" });
    createSession("child", project.id, { agentRuntimeType: "pi", parentSessionId: "parent" });
    const parent = createRuntimeStub();
    const child = createRuntimeStub({ messages: [{ role: "assistant", content: [{ type: "text", text: "Result" }] }] });
    const admission = Promise.withResolvers<void>();
    const reported = Promise.withResolvers<void>();
    parent.runtime.steer = async () => {
      await admission.promise;
      reported.resolve();
    };
    const state = createServerState();
    state.sessions.set("parent", { id: "parent", runtime: parent.runtime, lastActivity: 0 });
    const manager = new SessionManager(state);
    const instance = new SessionInstance(manager, "child");

    instance.started("run-1");
    instance.settled(child.runtime, { runId: "run-1", status: "completed" });
    instance.started("run-2");
    admission.resolve();
    await reported.promise;
    await Bun.sleep(0);

    expect(getSession("child")?.activity_state).toBe("running");
  });

  test("retains finished child activity when no valid parent is available", async () => {
    const parentProject = createProject("Parent project", "/tmp/parent-project-test");
    const childProject = createProject("Child project", "/tmp/child-project-test");
    createSession("parent", parentProject.id, { agentRuntimeType: "pi" });
    createSession("child", childProject.id, { agentRuntimeType: "pi", parentSessionId: "parent" });
    const child = createRuntimeStub({ messages: [{ role: "assistant", content: [{ type: "text", text: "Result" }] }] });
    const finished = Promise.withResolvers<void>();
    const manager = new SessionManager(createServerState());
    Object.defineProperty(manager, "broadcast", { value: (event: { type: string }) => {
      if (event.type === "session_updated" && getSession("child")?.activity_state === "finished") finished.resolve();
    } });
    const instance = new SessionInstance(manager, "child");

    instance.started("run-1");
    instance.settled(child.runtime, { runId: "run-1", status: "completed" });
    await finished.promise;

    expect(getSession("child")?.activity_state).toBe("finished");
  });

  test("retains finished child activity when parent delivery fails", async () => {
    const project = createProject("Failed reporter", "/tmp/failed-reporter-test");
    createSession("parent", project.id, { agentRuntimeType: "pi" });
    createSession("child", project.id, { agentRuntimeType: "pi", parentSessionId: "parent" });
    const parent = createRuntimeStub();
    parent.runtime.steer = async () => { throw new Error("parent unavailable"); };
    const child = createRuntimeStub({ messages: [{ role: "assistant", content: [{ type: "text", text: "Result" }] }] });
    const state = createServerState();
    state.sessions.set("parent", { id: "parent", runtime: parent.runtime, lastActivity: 0 });
    const manager = new SessionManager(state);
    const instance = new SessionInstance(manager, "child");

    instance.started("run-1");
    instance.settled(child.runtime, { runId: "run-1", status: "completed" });
    for (let i = 0; i < 100 && getSession("child")?.activity_state !== null; i++) await Bun.sleep(10);

    expect(getSession("child")?.activity_state).toBeNull();
  });

  test("finishes a child without reporting to its parent when its final reply cannot be read", async () => {
    const project = createProject("Unreadable reply", "/tmp/unreadable-reply-test");
    createSession("parent", project.id, { agentRuntimeType: "pi" });
    createSession("child", project.id, { agentRuntimeType: "pi", parentSessionId: "parent" });
    const parent = createRuntimeStub();
    const child = createRuntimeStub();
    child.runtime.getMessages = async () => { throw new Error("transcript unavailable"); };
    const state = createServerState();
    state.sessions.set("parent", { id: "parent", runtime: parent.runtime, lastActivity: 0 });
    const instance = new SessionInstance(new SessionManager(state), "child");

    instance.started("run-1");
    instance.settled(child.runtime, { runId: "run-1", status: "completed" });
    for (let i = 0; i < 100 && getSession("child")?.activity_state !== "finished"; i++) await Bun.sleep(5);
    await Bun.sleep(20);

    expect(getSession("child")?.activity_state).toBe("finished");
    expect(parent.steerCalls).toEqual([]);
    expect(getDb().query("SELECT COUNT(*) n FROM node_command_outbox").get()).toEqual({ n: 0 });
  });

  describe("wait for a node-owned session (durable settlement, no node runtime)", () => {
    function setup() {
      const project = createProject("Node wait", "/tmp/node-wait-test");
      createSession("caller", project.id, { agentRuntimeType: "pi" });
      createProvisionedNodeSession("node", project.id);
      const state = createServerState();
      return { state, reports: nodeSessionReports(state), caller: new SessionInstance(new SessionManager(state), "caller") };
    }

    test("resolves on the durable settlement of queued work, bridging admission before the started report", async () => {
      const { reports, caller } = setup();
      const command = queuePrompt("node", "client-1");
      expect(await caller.wait("node", 0)).toEqual({ sessionId: "node", status: "timeout", result: null, error: null });
      let done = false;
      const waiting = caller.wait("node", 2000).finally(() => { done = true; });
      admitInput(command, "client-1");
      await Bun.sleep(30);
      // Admitted, but `session.started` has not arrived: still waiting.
      expect(done).toBe(false);
      reports.started({ sessionId: "node", runId: "run-1" });
      await Bun.sleep(30);
      expect(done).toBe(false);
      persistCanonicalMessages("node", [{ role: "user", content: [{ type: "text", text: "Work" }], timestamp: 1 }, reply("Node result")]);
      reports.settled(settled("run-1", "completed"));
      expect(await waiting).toEqual({ sessionId: "node", status: "completed", result: "Node result", error: null });
      // Already settled: resolves at once from projections.
      expect(await caller.wait("node", 0)).toEqual({ sessionId: "node", status: "completed", result: "Node result", error: null });
    });

    test("returns failed and cancelled settlements and times out while running", async () => {
      const { reports, caller } = setup();
      persistCanonicalMessages("node", [reply("partial")]);
      reports.started({ sessionId: "node", runId: "run-1" });
      expect(await caller.wait("node", 20)).toEqual({ sessionId: "node", status: "timeout", result: null, error: null });
      reports.settled(settled("run-1", "failed", "Provider failed"));
      expect(await caller.wait("node", 0)).toEqual({ sessionId: "node", status: "failed", result: null, error: "Provider failed" });
      reports.started({ sessionId: "node", runId: "run-2" });
      reports.settled(settled("run-2", "aborted", "Aborted"));
      expect(await caller.wait("node", 0)).toEqual({ sessionId: "node", status: "cancelled", result: null, error: "Aborted" });
    });

    test("an input that failed delivery expects no run; a lost provision is a failed open", async () => {
      const { caller } = setup();
      persistCanonicalMessages("node", []);
      const command = queuePrompt("node", "client-1");
      const waiting = caller.wait("node", 2000);
      claimCommand(command);
      settleCommand(command, "failed", JSON.stringify({ ok: false, error: { code: "invalid_request", message: "rejected", retryable: false } }));
      deleteFailedCommand(command);
      expect(await waiting).toEqual({ sessionId: "node", status: "idle", result: null, error: null });
      getDb().query("DELETE FROM node_command_outbox WHERE session_id = 'node'").run();
      expect(await caller.wait("node", 0)).toEqual({ sessionId: "node", status: "failed", result: null, error: "Session open failed" });
    });

    test("a child resolves with its settlement after reporting to its parent", async () => {
      const project = createProject("Node child wait", "/tmp/node-child-wait-test");
      createSession("parent", project.id, { agentRuntimeType: "pi" });
      createProvisionedNodeSession("node", project.id, { parentSessionId: "parent" });
      const parent = createRuntimeStub();
      const state = createServerState();
      state.sessions.set("parent", { id: "parent", runtime: parent.runtime, lastActivity: 0 });
      const reports = nodeSessionReports(state);
      const command = queuePrompt("node", "client-1");
      const waiting = new SessionInstance(new SessionManager(state), "parent").wait("node", 2000);
      admitInput(command, "client-1");
      reports.started({ sessionId: "node", runId: "run-1" });
      persistCanonicalMessages("node", [reply("Child result")]);
      reports.settled({ ...settled("run-1", "completed"), reply: { text: "Child result", stopReason: "stop", errorMessage: null } });
      expect(await waiting).toEqual({ sessionId: "node", status: "completed", result: "Child result", error: null });
      expect(getSession("node")?.activity_state).toBeNull();
      for (let i = 0; i < 100 && parent.steerCalls.length === 0; i++) await Bun.sleep(5);
      expect(parent.steerCalls).toEqual([[{ type: "text", text: "Child result" }]]);
    });
  });
});

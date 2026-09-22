import { describe, expect, test } from "bun:test";
import { getDb } from "../../db.js";
import { SessionInstance } from "../../runtimes/session-instance.js";
import { SessionManager } from "../../runtimes/session-manager.js";
import { createProject } from "../../project-store.js";
import { createSession, getSession } from "../../session-store.js";
import { useTestDb } from "../helpers/test-db.js";
import { createRuntimeStub } from "../helpers/test-runtime-stub.js";
import { createServerState } from "../helpers/server-state.js";

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
    const cleared = Promise.withResolvers<void>();
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
      if (current === "null") cleared.resolve();
    } });
    const instance = new SessionInstance(manager, "child");

    instance.started("run-1");
    instance.settled(child.runtime, {
      runId: "run-1",
      status: "failed",
      error: { code: "provider_error", message: "Provider unavailable" },
    });
    await Bun.sleep(0);

    expect(getSession("child")?.activity_state).toBe("running");
    expect(activity).toEqual(["running"]);

    admission.resolve();
    await cleared.promise;

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
    const finished = Promise.withResolvers<void>();
    const state = createServerState();
    state.sessions.set("parent", { id: "parent", runtime: parent.runtime, lastActivity: 0 });
    const manager = new SessionManager(state);
    Object.defineProperty(manager, "broadcast", { value: (event: { type: string }) => {
      if (event.type === "session_updated" && getSession("child")?.activity_state === "finished") finished.resolve();
    } });
    const instance = new SessionInstance(manager, "child");

    instance.started("run-1");
    instance.settled(child.runtime, { runId: "run-1", status: "completed" });
    await finished.promise;

    expect(getSession("child")?.activity_state).toBe("finished");
  });
});

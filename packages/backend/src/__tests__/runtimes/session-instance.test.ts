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

  test("delivers addressed messages through native steering before broadcasting", async () => {
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
    expect(stub.steerOptions).toEqual([{ metadata: { sourceSessionId: "source" } }]);
    expect(broadcasts).toEqual([{
      type: "user_message",
      sessionId: "target",
      projectId: project.id,
      message: [{ type: "text", text: "First" }],
      metadata: { sourceSessionId: "source" },
    }]);
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

    instance.started();
    instance.settled(stub.runtime, { runId: "run-1", status: "completed" });

    expect(stub.getMessagesCalls).toBe(0);
    expect(getDb().query<{ message_json: string }, []>("SELECT message_json FROM session_messages").get()!.message_json).toBe(original);
    expect(getSession("session")).toMatchObject({ activity_state: "finished", model_provider: "faux", model_id: "model", thinking_level: "high" });
  });

  test("persists settlement before reporting its authoritative outcome", async () => {
    const project = createProject("Reporter", "/tmp/reporter-test");
    createSession("parent", project.id, { agentRuntimeType: "pi" });
    createSession("child", project.id, { agentRuntimeType: "pi", parentSessionId: "parent" });
    const parent = createRuntimeStub();
    const child = createRuntimeStub({ messages: [{ role: "assistant", content: [{ type: "text", text: "stale success" }] }] });
    const activity: string[] = [];
    const delivered = Promise.withResolvers<void>();
    const state = createServerState();
    state.sessions.set("parent", { id: "parent", runtime: parent.runtime, lastActivity: 0 });
    const manager = new SessionManager(state);
    Object.defineProperty(manager, "broadcast", { value: (event: { type: string }) => {
      if (event.type === "session_updated") activity.push(getSession("child")?.activity_state ?? "null");
      if (event.type === "user_message") delivered.resolve();
    } });
    const instance = new SessionInstance(manager, "child");

    instance.started();
    instance.settled(child.runtime, {
      runId: "run-1",
      status: "failed",
      error: { code: "provider_error", message: "Provider unavailable" },
    });
    await delivered.promise;

    expect(activity).toEqual(["running", "finished"]);
    expect(parent.steerCalls).toHaveLength(1);
    const notification = parent.steerCalls[0]?.find((block) => block.type === "text")?.text;
    expect(notification).toBe("Session failed: Provider unavailable");
    expect(notification).not.toContain("stale success");
    expect(parent.steerOptions).toEqual([{ metadata: { sourceSessionId: "child" } }]);
  });
});

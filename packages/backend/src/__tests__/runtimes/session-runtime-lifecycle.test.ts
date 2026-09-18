import { describe, expect, test } from "bun:test";
import { getDb } from "../../db.js";
import { SessionMessages } from "../../models/session-messages.js";
import { SessionRuntimeLifecycle } from "../../runtimes/session-runtime-lifecycle.js";
import { Sessions } from "../../models/sessions.js";
import { createProject } from "../../project-store.js";
import { createSession, getSession } from "../../session-store.js";
import { useTestDb } from "../helpers/test-db.js";
import { createRuntimeStub } from "../helpers/test-runtime-stub.js";

describe("session runtime lifecycle", () => {
  useTestDb();

  test("updates activity and metadata without reading or rewriting canonical entries", () => {
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
    const managed = new Map();
    const lifecycle = new SessionRuntimeLifecycle(
      "session",
      new Sessions(managed),
      new SessionMessages(managed, () => {}),
    );

    lifecycle.started();
    lifecycle.settled(stub.runtime, { runId: "run-1", status: "completed" });

    expect(stub.getMessagesCalls).toBe(0);
    expect(getDb().query<{ message_json: string }, []>("SELECT message_json FROM session_messages").get()!.message_json).toBe(original);
    expect(getSession("session")).toMatchObject({ activity_state: "finished", model_provider: "faux", model_id: "model", thinking_level: "high" });
  });

  test("preserves activity ordering before reporting the authoritative outcome", async () => {
    const project = createProject("Reporter", "/tmp/reporter-test");
    createSession("parent", project.id, { agentRuntimeType: "pi" });
    createSession("child", project.id, { agentRuntimeType: "pi", parentSessionId: "parent" });
    const parent = createRuntimeStub();
    const child = createRuntimeStub({ messages: [{ role: "assistant", content: [{ type: "text", text: "stale success" }] }] });
    const activity: string[] = [];
    const delivered = Promise.withResolvers<void>();
    const managed = new Map([
      ["parent", { id: "parent", runtime: parent.runtime, lastActivity: 0 }],
    ]);
    const lifecycle = new SessionRuntimeLifecycle(
      "child",
      new Sessions(managed, (event) => {
        if (event.type === "session_updated") activity.push(getSession("child")?.activity_state ?? "null");
      }),
      new SessionMessages(managed, () => delivered.resolve()),
    );

    lifecycle.started();
    lifecycle.settled(child.runtime, {
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

import { describe, expect, test } from "bun:test";
import { getDb } from "../../db.js";
import { Sessions } from "../../models/sessions.js";
import { createProject } from "../../project-store.js";
import { createSession, getSession } from "../../session-store.js";
import { attachRuntimeLifecycleObserver } from "../../runtimes/runtime-lifecycle-observer.js";
import { useTestDb } from "../helpers/test-db.js";
import { createRuntimeStub } from "../helpers/test-runtime-stub.js";

describe("runtime lifecycle observer", () => {
  useTestDb();

  test("updates lifecycle and metadata without reading or rewriting canonical entries", async () => {
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
    const detach = attachRuntimeLifecycleObserver({ sessionId: "session", runtime: stub.runtime, sessions: new Sessions(new Map()) });

    stub.emit({ type: "agent_start" });
    stub.emit({ type: "agent_end", messages: [], runId: "run-1", status: "completed" });

    expect(stub.getMessagesCalls).toBe(0);
    expect(getDb().query<{ message_json: string }, []>("SELECT message_json FROM session_messages").get()!.message_json).toBe(original);
    expect(getSession("session")).toMatchObject({ activity_state: "finished", model_provider: "faux", model_id: "model", thinking_level: "high" });
    detach();
  });

  test("keeps compaction active until terminal agent_end", async () => {
    const project = createProject("Compaction", "/tmp/lifecycle-compaction");
    createSession("compacting", project.id, { agentRuntimeType: "pi" });
    const stub = createRuntimeStub();
    const detach = attachRuntimeLifecycleObserver({
      sessionId: "compacting", runtime: stub.runtime, sessions: new Sessions(new Map()),
    });

    stub.emit({ type: "compaction_start", reason: "threshold" });
    expect(getSession("compacting")?.activity_state).toBe("running");
    stub.emit({ type: "compaction_end" });
    expect(getSession("compacting")?.activity_state).toBe("running");
    stub.emit({ type: "agent_end", messages: [], runId: "run-1", status: "completed" });
    expect(getSession("compacting")?.activity_state).toBe("finished");
    expect(stub.getMessagesCalls).toBe(0);
    detach();
  });

  test("preserves event order through terminal activity", () => {
    const project = createProject("Ordering", "/tmp/lifecycle-order");
    createSession("ordered", project.id, { agentRuntimeType: "pi" });
    const updates: string[] = [];
    const stub = createRuntimeStub();
    const sessions = new Sessions(new Map(), (event) => { if (event.type === "session_updated") updates.push(getSession("ordered")?.activity_state ?? "null"); });
    const detach = attachRuntimeLifecycleObserver({ sessionId: "ordered", runtime: stub.runtime, sessions });

    stub.emit({ type: "agent_start" });
    stub.emit({ type: "agent_end", messages: [], runId: "run-1", status: "completed" });

    expect(updates).toEqual(["running", "finished"]);
    detach();
  });
});

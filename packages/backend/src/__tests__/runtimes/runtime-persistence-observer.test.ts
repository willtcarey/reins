import { describe, expect, test } from "bun:test";
import { createProject } from "../../project-store.js";
import { createSession, getSession } from "../../session-store.js";
import { loadMessages, type RuntimeMessage } from "../../messages-store.js";
import { attachRuntimePersistenceObserver } from "../../runtimes/runtime-persistence-observer.js";
import type { Broadcast } from "../../models/broadcast.js";
import { useTestDb } from "../helpers/test-db.js";
import { createRuntimeStub } from "../helpers/test-runtime-stub.js";

const noopBroadcast: Broadcast = () => {};

describe("runtime persistence observer", () => {
  useTestDb();

  test("persists messages on agent_end", async () => {
    const project = createProject("Reins", "/tmp/reins-runtime-persistence-observer");
    createSession("sess-persist", project.id, { agentRuntimeType: "test_runtime" });

    const snapshot: RuntimeMessage[] = [
      { role: "user", content: [{ type: "text", text: "Summarize the latest changes" }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "Considering repository state" }] },
      { role: "assistant", content: [{ type: "text", text: "No changes were made." }] },
    ];

    const { runtime, emit } = createRuntimeStub({ messages: snapshot });
    const broadcast = noopBroadcast;

    const detach = attachRuntimePersistenceObserver({
      sessionId: "sess-persist",
      projectId: project.id,
      runtime,
      broadcast,
    });

    emit({ type: "agent_end", messages: [] });

    // Wait for the async persistence to complete
    await Bun.sleep(50);

    expect(loadMessages("sess-persist")).toEqual(snapshot);

    detach();
  });

  test("does not persist messages on events that are not checkpoints", async () => {
    const project = createProject("Reins", "/tmp/reins-runtime-persistence-observer");
    createSession("sess-no-persist", project.id, { agentRuntimeType: "test_runtime" });

    const { runtime, emit, getMessagesCalls } = createRuntimeStub();
    const broadcast = noopBroadcast;

    const detach = attachRuntimePersistenceObserver({
      sessionId: "sess-no-persist",
      projectId: project.id,
      runtime,
      broadcast,
    });

    emit({ type: "turn_start" });

    await Bun.sleep(50);

    expect(getMessagesCalls).toBe(0);

    detach();
  });

  test("persists activity_state='running' on agent_start", async () => {
    const project = createProject("Reins", "/tmp/reins-activity");
    createSession("sess-activity", project.id, { agentRuntimeType: "test_runtime" });

    const { runtime, emit } = createRuntimeStub();
    const broadcast = noopBroadcast;

    const detach = attachRuntimePersistenceObserver({
      sessionId: "sess-activity",
      projectId: project.id,
      runtime,
      broadcast,
    });

    emit({ type: "agent_start" });
    await Bun.sleep(50);

    expect(getSession("sess-activity")!.activity_state).toBe("running");

    detach();
  });

  test("persists activity_state='finished' on agent_end", async () => {
    const project = createProject("Reins", "/tmp/reins-activity");
    createSession("sess-activity", project.id, { agentRuntimeType: "test_runtime" });

    const { runtime, emit } = createRuntimeStub();
    const broadcast = noopBroadcast;

    const detach = attachRuntimePersistenceObserver({
      sessionId: "sess-activity",
      projectId: project.id,
      runtime,
      broadcast,
    });

    emit({ type: "agent_start" });
    await Bun.sleep(50);
    expect(getSession("sess-activity")!.activity_state).toBe("running");

    emit({ type: "agent_end", messages: [] });
    await Bun.sleep(50);
    expect(getSession("sess-activity")!.activity_state).toBe("finished");

    detach();
  });

  test("broadcasts activity_updated on agent_start and agent_end", async () => {
    const project = createProject("Reins", "/tmp/reins-activity");
    createSession("sess-bcast", project.id, { agentRuntimeType: "test_runtime" });

    const { runtime, emit } = createRuntimeStub();
    const broadcasts: Array<{ type: string; activityState: string | null }> = [];
    const broadcast: Broadcast = (msg) => {
      if (msg.type === "activity_updated") {
        broadcasts.push({ type: msg.type, activityState: msg.activityState });
      }
    };

    const detach = attachRuntimePersistenceObserver({
      sessionId: "sess-bcast",
      projectId: project.id,
      runtime,
      broadcast,
    });

    emit({ type: "agent_start" });
    await Bun.sleep(50);
    expect(broadcasts).toContainEqual({ type: "activity_updated", activityState: "running" });

    emit({ type: "agent_end", messages: [] });
    await Bun.sleep(50);
    expect(broadcasts).toContainEqual({ type: "activity_updated", activityState: "finished" });

    detach();
  });
});

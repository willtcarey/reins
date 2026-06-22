import { describe, expect, test } from "bun:test";
import { createProject } from "../../project-store.js";
import { createSession, getSession } from "../../session-store.js";
import { loadMessages, type RuntimeMessage } from "../../messages-store.js";
import { Sessions } from "../../models/sessions.js";
import { attachRuntimePersistenceObserver } from "../../runtimes/runtime-persistence-observer.js";
import type { Broadcast } from "../../models/broadcast.js";
import { useTestDb } from "../helpers/test-db.js";
import { createRuntimeStub } from "../helpers/test-runtime-stub.js";

const noopBroadcast: Broadcast = () => {};

function makeSessions(broadcast: Broadcast = noopBroadcast): Sessions {
  return new Sessions(new Map(), broadcast);
}

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

    const detach = attachRuntimePersistenceObserver({
      sessionId: "sess-persist",
      runtime,
      sessions: makeSessions(),
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

    const detach = attachRuntimePersistenceObserver({
      sessionId: "sess-no-persist",
      runtime,
      sessions: makeSessions(),
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

    const detach = attachRuntimePersistenceObserver({
      sessionId: "sess-activity",
      runtime,
      sessions: makeSessions(),
    });

    emit({ type: "agent_start" });
    await Bun.sleep(50);

    expect(getSession("sess-activity")!.activity_state).toBe("running");

    detach();
  });

  test("persists activity_state='running' on compaction_start", async () => {
    const project = createProject("Reins", "/tmp/reins-compaction-activity");
    createSession("sess-compacting", project.id, { agentRuntimeType: "test_runtime" });

    const { runtime, emit, getMessagesCalls } = createRuntimeStub();
    const broadcasts: unknown[] = [];
    const broadcast: Broadcast = (msg) => {
      broadcasts.push(msg);
    };

    const detach = attachRuntimePersistenceObserver({
      sessionId: "sess-compacting",
      runtime,
      sessions: makeSessions(broadcast),
    });

    emit({ type: "compaction_start", reason: "threshold" });
    await Bun.sleep(50);

    expect(getSession("sess-compacting")!.activity_state).toBe("running");
    expect(getMessagesCalls).toBe(0);
    expect(broadcasts).toContainEqual({
      type: "session_updated",
      sessionId: "sess-compacting",
      projectId: project.id,
    });

    detach();
  });

  test("persists activity_state='finished' on terminal compaction_end", async () => {
    const project = createProject("Reins", "/tmp/reins-terminal-compaction-activity");
    createSession("sess-terminal-compaction", project.id, { agentRuntimeType: "test_runtime" });

    const { runtime, emit } = createRuntimeStub();

    const detach = attachRuntimePersistenceObserver({
      sessionId: "sess-terminal-compaction",
      runtime,
      sessions: makeSessions(),
    });

    emit({ type: "agent_start" });
    await Bun.sleep(50);
    expect(getSession("sess-terminal-compaction")!.activity_state).toBe("running");

    emit({ type: "agent_end", messages: [] });
    await Bun.sleep(50);
    expect(getSession("sess-terminal-compaction")!.activity_state).toBe("finished");

    emit({ type: "compaction_start", reason: "threshold" });
    await Bun.sleep(50);
    expect(getSession("sess-terminal-compaction")!.activity_state).toBe("running");

    emit({ type: "compaction_end", result: { summary: "done" }, aborted: false, willRetry: false });
    await Bun.sleep(50);
    expect(getSession("sess-terminal-compaction")!.activity_state).toBe("finished");

    detach();
  });

  test("keeps activity_state='running' on retrying compaction_end", async () => {
    const project = createProject("Reins", "/tmp/reins-retrying-compaction-activity");
    createSession("sess-retrying-compaction", project.id, { agentRuntimeType: "test_runtime" });

    const { runtime, emit } = createRuntimeStub();

    const detach = attachRuntimePersistenceObserver({
      sessionId: "sess-retrying-compaction",
      runtime,
      sessions: makeSessions(),
    });

    emit({ type: "compaction_start", reason: "overflow" });
    await Bun.sleep(50);
    expect(getSession("sess-retrying-compaction")!.activity_state).toBe("running");

    emit({ type: "compaction_end", result: { summary: "done" }, aborted: false, willRetry: true });
    await Bun.sleep(50);
    expect(getSession("sess-retrying-compaction")!.activity_state).toBe("running");

    detach();
  });

  test("persists activity_state='finished' on agent_end", async () => {
    const project = createProject("Reins", "/tmp/reins-activity");
    createSession("sess-activity", project.id, { agentRuntimeType: "test_runtime" });

    const { runtime, emit } = createRuntimeStub();

    const detach = attachRuntimePersistenceObserver({
      sessionId: "sess-activity",
      runtime,
      sessions: makeSessions(),
    });

    emit({ type: "agent_start" });
    await Bun.sleep(50);
    expect(getSession("sess-activity")!.activity_state).toBe("running");

    emit({ type: "agent_end", messages: [] });
    await Bun.sleep(50);
    expect(getSession("sess-activity")!.activity_state).toBe("finished");

    detach();
  });

  test("broadcasts session_updated on agent_start and agent_end", async () => {
    const project = createProject("Reins", "/tmp/reins-activity");
    createSession("sess-bcast", project.id, { agentRuntimeType: "test_runtime" });

    const { runtime, emit } = createRuntimeStub();
    const broadcasts: unknown[] = [];
    const broadcast: Broadcast = (msg) => {
      broadcasts.push(msg);
    };

    const detach = attachRuntimePersistenceObserver({
      sessionId: "sess-bcast",
      runtime,
      sessions: makeSessions(broadcast),
    });

    emit({ type: "agent_start" });
    await Bun.sleep(50);
    expect(broadcasts).toContainEqual({
      type: "session_updated",
      sessionId: "sess-bcast",
      projectId: project.id,
    });

    emit({ type: "agent_end", messages: [] });
    await Bun.sleep(50);
    expect(broadcasts).toContainEqual({
      type: "session_updated",
      sessionId: "sess-bcast",
      projectId: project.id,
    });

    detach();
  });

  test("does not persist or broadcast running/finished activity for delegate sessions", async () => {
    const project = createProject("Reins", "/tmp/reins-delegate-activity");
    createSession("sess-parent", project.id, { agentRuntimeType: "test_runtime" });
    createSession("sess-child", project.id, {
      agentRuntimeType: "test_runtime",
      parentSessionId: "sess-parent",
    });

    const { runtime, emit } = createRuntimeStub();
    const broadcasts: unknown[] = [];
    const broadcast: Broadcast = (msg) => {
      broadcasts.push(msg);
    };

    const detach = attachRuntimePersistenceObserver({
      sessionId: "sess-child",
      runtime,
      sessions: makeSessions(broadcast),
    });

    emit({ type: "compaction_start", reason: "threshold" });
    await Bun.sleep(50);
    expect(getSession("sess-child")!.activity_state).toBeNull();

    emit({ type: "agent_start" });
    await Bun.sleep(50);
    expect(getSession("sess-child")!.activity_state).toBeNull();

    emit({ type: "agent_end", messages: [] });
    await Bun.sleep(50);
    expect(getSession("sess-child")!.activity_state).toBeNull();
    expect(broadcasts).toEqual([]);

    detach();
  });
});

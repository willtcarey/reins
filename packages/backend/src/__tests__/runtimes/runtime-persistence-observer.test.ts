import { describe, expect, test } from "bun:test";
import { createProject } from "../../project-store.js";
import { createSession, getSession } from "../../session-store.js";
import { loadMessages, type RuntimeMessage } from "../../messages-store.js";
import { Sessions } from "../../models/sessions.js";
import { attachRuntimePersistenceObserver } from "../../runtimes/runtime-persistence-observer.js";
import type { Broadcast } from "../../models/broadcast.js";
import type { AgentRuntime, AgentRuntimeEvent } from "../../runtimes/registry.js";
import { useTestDb } from "../helpers/test-db.js";
import { createRuntimeStub } from "../helpers/test-runtime-stub.js";
import piCompactionTrace from "./pi/fixtures/compaction-trace.json";

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

  test("serializes checkpoint snapshots in event order", async () => {
    const project = createProject("Reins", "/tmp/reins-ordered-checkpoints");
    createSession("sess-ordered", project.id, { agentRuntimeType: "test_runtime" });

    const firstSnapshot: RuntimeMessage[] = [{ role: "user", content: [{ type: "text", text: "first" }] }];
    const secondSnapshot: RuntimeMessage[] = [
      ...firstSnapshot,
      { role: "assistant", content: [{ type: "text", text: "second" }] },
    ];
    let resolveFirst!: (messages: RuntimeMessage[]) => void;
    const first = new Promise<RuntimeMessage[]>((resolve) => { resolveFirst = resolve; });
    let getMessagesCalls = 0;
    const listeners = new Set<(event: AgentRuntimeEvent) => void>();
    const runtime = {
      subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      getMessages() {
        getMessagesCalls += 1;
        return getMessagesCalls === 1 ? first : Promise.resolve(secondSnapshot);
      },
      async prompt() {},
      async steer() {},
      async abort() {},
      async setModel() {},
      isStreaming: () => false,
      async close() {},
    } satisfies AgentRuntime;
    const emit = (event: AgentRuntimeEvent) => {
      for (const listener of listeners) listener(event);
    };

    const detach = attachRuntimePersistenceObserver({
      sessionId: "sess-ordered",
      runtime,
      sessions: makeSessions(),
    });

    emit({ type: "turn_end", message: secondSnapshot[0], toolResults: [] });
    emit({ type: "agent_end", messages: [] });
    await Bun.sleep(10);
    expect(getMessagesCalls).toBe(1);

    resolveFirst(firstSnapshot);
    await Bun.sleep(50);
    expect(getMessagesCalls).toBe(2);
    expect(loadMessages("sess-ordered")).toEqual(secondSnapshot);

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

  test("uses Pi's captured settlement boundary across post-agent threshold compaction", async () => {
    const project = createProject("Reins", "/tmp/reins-pi-settlement-activity");
    createSession("sess-pi-settlement", project.id, { agentRuntimeType: "pi" });
    const { runtime, emit } = createRuntimeStub({ activityCompletionBoundary: "agent_settled" });
    const detach = attachRuntimePersistenceObserver({
      sessionId: "sess-pi-settlement",
      runtime,
      sessions: makeSessions(),
    });

    const capturedLifecycle = piCompactionTrace.events
      .map(({ event }) => event)
      .filter((event) => ["agent_start", "agent_end", "compaction_start", "compaction_end", "agent_settled"].includes(event.type));
    expect(capturedLifecycle.map(({ type }) => type)).toEqual([
      "agent_start",
      "agent_end",
      "compaction_start",
      "compaction_end",
      "agent_settled",
    ]);

    for (const event of capturedLifecycle) {
      if (event.type === "agent_start" || event.type === "agent_settled") {
        emit({ type: event.type });
      } else if (event.type === "agent_end") {
        emit({ type: "agent_end", messages: [] });
      } else if (event.type === "compaction_start") {
        emit({ type: "compaction_start", reason: event.reason! });
      } else if (event.type === "compaction_end") {
        emit({
          type: "compaction_end",
          result: event.result,
          aborted: event.aborted,
          willRetry: event.willRetry,
        });
      }
      await Bun.sleep(10);
      expect(getSession("sess-pi-settlement")!.activity_state).toBe(
        event.type === "agent_settled" ? "finished" : "running",
      );
    }

    detach();
  });

  test("a delayed settlement-aware agent_end checkpoint cannot finish activity during compaction", async () => {
    const project = createProject("Reins", "/tmp/reins-pi-delayed-agent-end");
    createSession("sess-pi-delayed", project.id, { agentRuntimeType: "pi" });
    let resolveMessages!: (messages: RuntimeMessage[]) => void;
    const messages = new Promise<RuntimeMessage[]>((resolve) => { resolveMessages = resolve; });
    const { runtime, emit } = createRuntimeStub({ activityCompletionBoundary: "agent_settled" });
    runtime.getMessages = () => messages;
    const detach = attachRuntimePersistenceObserver({
      sessionId: "sess-pi-delayed",
      runtime,
      sessions: makeSessions(),
    });

    emit({ type: "agent_start" });
    emit({ type: "agent_end", messages: [] });
    emit({ type: "compaction_start", reason: "threshold" });
    await Bun.sleep(10);
    expect(getSession("sess-pi-delayed")!.activity_state).toBe("running");

    resolveMessages([]);
    await Bun.sleep(20);
    expect(getSession("sess-pi-delayed")!.activity_state).toBe("running");

    detach();
  });

  test("settlement waits behind compacted persistence before broadcasting finished", async () => {
    const project = createProject("Reins", "/tmp/reins-pi-settled-checkpoint-order");
    createSession("sess-pi-ordered", project.id, { agentRuntimeType: "pi" });
    const preCompaction: RuntimeMessage[] = [{ role: "assistant", content: [{ type: "text", text: "long transcript" }] }];
    const compacted: RuntimeMessage[] = [{ role: "compactionSummary", summary: "compacted transcript" }];
    let resolveCompaction!: (messages: RuntimeMessage[]) => void;
    const compactionMessages = new Promise<RuntimeMessage[]>((resolve) => { resolveCompaction = resolve; });
    let calls = 0;
    const { runtime, emit } = createRuntimeStub({ activityCompletionBoundary: "agent_settled" });
    runtime.getMessages = () => {
      calls += 1;
      return calls === 1 ? Promise.resolve(preCompaction) : compactionMessages;
    };
    const persistedWhenFinished: RuntimeMessage[][] = [];
    const detach = attachRuntimePersistenceObserver({
      sessionId: "sess-pi-ordered",
      runtime,
      sessions: makeSessions(() => {
        if (getSession("sess-pi-ordered")!.activity_state === "finished") {
          persistedWhenFinished.push(loadMessages("sess-pi-ordered"));
        }
      }),
    });

    emit({ type: "agent_start" });
    emit({ type: "agent_end", messages: [] });
    emit({ type: "compaction_start", reason: "threshold" });
    emit({ type: "compaction_end", aborted: false, willRetry: false, result: { summary: "compacted transcript" } });
    emit({ type: "agent_settled" });
    await Bun.sleep(20);
    expect(getSession("sess-pi-ordered")!.activity_state).toBe("running");
    expect(persistedWhenFinished).toEqual([]);

    resolveCompaction(compacted);
    await Bun.sleep(30);
    expect(getSession("sess-pi-ordered")!.activity_state).toBe("finished");
    expect(persistedWhenFinished).toEqual([[...preCompaction, ...compacted]]);

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

  test("broadcasts running immediately but persists final messages before the finished session update", async () => {
    const project = createProject("Reins", "/tmp/reins-activity");
    createSession("sess-bcast", project.id, { agentRuntimeType: "test_runtime" });
    const snapshot: RuntimeMessage[] = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ];
    const { runtime, emit } = createRuntimeStub({ messages: snapshot });
    const broadcasts: unknown[] = [];
    const persistedAtBroadcast: RuntimeMessage[][] = [];
    const broadcast: Broadcast = (msg) => {
      broadcasts.push(msg);
      persistedAtBroadcast.push(loadMessages("sess-bcast"));
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

    expect(persistedAtBroadcast).toEqual([[]]);

    emit({ type: "agent_end", messages: [] });
    await Bun.sleep(50);
    expect(broadcasts).toHaveLength(2);
    expect(broadcasts[1]).toEqual({
      type: "session_updated",
      sessionId: "sess-bcast",
      projectId: project.id,
    });
    expect(persistedAtBroadcast[1]).toEqual(snapshot);

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

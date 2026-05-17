import { describe, expect, test } from "bun:test";
import { createProject } from "../../project-store.js";
import { createSession } from "../../session-store.js";
import { loadMessages } from "../../messages-store.js";
import { attachRuntimePersistenceObserver } from "../../runtimes/runtime-persistence-observer.js";
import type { AgentRuntime, AgentRuntimeEvent } from "../../runtimes/registry.js";
import { useTestDb } from "../helpers/test-db.js";

describe("runtime persistence observer", () => {
  useTestDb();

  test("persists messages on agent_end", async () => {
    const project = createProject("Reins", "/tmp/reins-runtime-persistence-observer");
    createSession("sess-persist", project.id, { agentRuntimeType: "test_runtime" });

    const snapshot = [
      { role: "user", content: [{ type: "text" as const, text: "Summarize the latest changes" }] },
      { role: "assistant", content: [{ type: "thinking" as const, thinking: "Considering repository state" }] },
      { role: "assistant", content: [{ type: "text" as const, text: "No changes were made." }] },
    ];

    const listeners = new Set<(event: AgentRuntimeEvent) => void>();

    const runtime: AgentRuntime = {
      async prompt() {},
      async steer() {},
      async abort() {},
      async setModel() {},
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      async getMessages() {
        return snapshot.map((message) => ({ ...message }));
      },
      isStreaming() {
        return false;
      },
      async close() {},
    };

    const detach = attachRuntimePersistenceObserver({
      sessionId: "sess-persist",
      runtime,
    });

    const emit = (event: AgentRuntimeEvent) => {
      for (const listener of listeners) {
        listener(event);
      }
    };

    emit({ type: "agent_end", messages: [] });

    // Wait for the async persistence to complete
    await Bun.sleep(50);

    expect(loadMessages("sess-persist")).toEqual(snapshot);

    detach();
  });

  test("does not persist on events that are not checkpoints", async () => {
    const project = createProject("Reins", "/tmp/reins-runtime-persistence-observer");
    createSession("sess-no-persist", project.id, { agentRuntimeType: "test_runtime" });

    let getMessagesCalls = 0;
    const listeners = new Set<(event: AgentRuntimeEvent) => void>();

    const runtime: AgentRuntime = {
      async prompt() {},
      async steer() {},
      async abort() {},
      async setModel() {},
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      async getMessages() {
        getMessagesCalls += 1;
        return [];
      },
      isStreaming() {
        return false;
      },
      async close() {},
    };

    const detach = attachRuntimePersistenceObserver({
      sessionId: "sess-no-persist",
      runtime,
    });

    const emit = (event: AgentRuntimeEvent) => {
      for (const listener of listeners) {
        listener(event);
      }
    };

    emit({ type: "agent_start" });
    emit({ type: "turn_start" });

    await Bun.sleep(50);

    expect(getMessagesCalls).toBe(0);

    detach();
  });
});

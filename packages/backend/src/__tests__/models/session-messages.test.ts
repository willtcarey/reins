import { describe, expect, test } from "bun:test";
import { SessionMessages } from "../../models/session-messages.js";
import { createProject } from "../../project-store.js";
import { createSession } from "../../session-store.js";
import { useTestDb } from "../helpers/test-db.js";
import { createRuntimeStub } from "../helpers/test-runtime-stub.js";

describe("SessionMessages", () => {
  useTestDb();

  test("delegates addressed delivery to native steering without inspecting runtime activity", async () => {
    const project = createProject("Messages", "/tmp/messages-test");
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
    const messages = new SessionMessages(new Map(), (event) => { broadcasts.push(event); },
      async () => ({ id: "target", runtime: stub.runtime, lastActivity: 0 }));

    const sending = messages.send("target", "First", { sourceSessionId: "source-1" });
    await Bun.sleep(0);
    expect(broadcasts).toEqual([]);
    admission.resolve();
    expect(await sending).toEqual({ sessionId: "target" });

    expect(stub.promptCalls).toEqual([]);
    expect(stub.steerCalls).toEqual([[{ type: "text", text: "First" }]]);
    expect(stub.steerOptions).toEqual([{ metadata: { sourceSessionId: "source-1" } }]);
    expect(broadcasts).toEqual([{
      type: "user_message",
      sessionId: "target",
      projectId: project.id,
      message: [{ type: "text", text: "First" }],
      metadata: { sourceSessionId: "source-1" },
    }]);
  });

  test("keeps initial prompt admission distinct from cross-session updates", async () => {
    const project = createProject("Messages", "/tmp/messages-test");
    createSession("target", project.id, { agentRuntimeType: "pi" });
    const stub = createRuntimeStub();
    const broadcasts: unknown[] = [];
    const messages = new SessionMessages(
      new Map([["target", { id: "target", runtime: stub.runtime, lastActivity: 0 }]]),
      (event) => { broadcasts.push(event); },
    );

    await messages.start("target", "Initial work");

    expect(stub.promptCalls).toEqual([[{ type: "text", text: "Initial work" }]]);
    expect(stub.promptOptions).toEqual([undefined]);
    expect(broadcasts).toEqual([{
      type: "user_message",
      sessionId: "target",
      projectId: project.id,
      message: [{ type: "text", text: "Initial work" }],
    }]);
  });

  test("broadcasts idle sends only after durable steering submission", async () => {
    const project = createProject("Messages", "/tmp/messages-test");
    createSession("target", project.id, { agentRuntimeType: "pi" });
    const stub = createRuntimeStub();
    const admission = Promise.withResolvers<void>();
    stub.runtime.steer = async () => {
      await admission.promise;
    };
    const broadcasts: unknown[] = [];
    const messages = new SessionMessages(
      new Map([["target", { id: "target", runtime: stub.runtime, lastActivity: 0 }]]),
      (event) => { broadcasts.push(event); },
    );

    const send = messages.send("target", "Accepted first");
    await Bun.sleep(0);
    expect(broadcasts).toEqual([]);
    admission.resolve();
    expect(await send).toEqual({ sessionId: "target" });
    expect(broadcasts).toHaveLength(1);
  });
});

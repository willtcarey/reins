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
    stub.runtime.steer = async (content) => {
      await admission.promise;
      stub.steerCalls.push(content);
    };
    stub.runtime.isStreaming = () => { throw new Error("activity must not choose delivery"); };
    const broadcasts: unknown[] = [];
    const messages = new SessionMessages(new Map(), (event) => { broadcasts.push(event); },
      async () => ({ id: "target", runtime: stub.runtime, lastActivity: 0 }));

    const sending = messages.send("target", "First");
    await Bun.sleep(0);
    expect(broadcasts).toEqual([]);
    admission.resolve();
    expect(await sending).toEqual({ sessionId: "target" });

    expect(stub.promptCalls).toEqual([]);
    expect(stub.steerCalls).toEqual([[{ type: "text", text: "First" }]]);
    expect(broadcasts).toHaveLength(1);
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

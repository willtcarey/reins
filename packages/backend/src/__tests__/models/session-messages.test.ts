import { describe, expect, test } from "bun:test";
import { SessionMessages } from "../../models/session-messages.js";
import { createProject } from "../../project-store.js";
import { createSession } from "../../session-store.js";
import { useTestDb } from "../helpers/test-db.js";
import { createRuntimeStub } from "../helpers/test-runtime-stub.js";

describe("SessionMessages", () => {
  useTestDb();

  test("opens idle recipients and steers busy recipients without waiting for a response", async () => {
    const project = createProject("Messages", "/tmp/messages-test");
    createSession("target", project.id, { agentRuntimeType: "pi" });
    const stub = createRuntimeStub();
    const admission = Promise.withResolvers<void>();
    stub.runtime.prompt = async (content) => {
      await admission.promise;
      stub.promptCalls.push(content);
      return { messageId: "accepted-entry" };
    };
    let busy = false;
    stub.runtime.isStreaming = () => busy;
    const broadcasts: unknown[] = [];
    const messages = new SessionMessages(new Map(), (event) => { broadcasts.push(event); },
      async () => ({ id: "target", runtime: stub.runtime, lastActivity: 0 }));

    const sending = messages.send("target", "First");
    await Bun.sleep(0);
    expect(broadcasts).toEqual([]);
    admission.resolve();
    expect(await sending).toEqual({ sessionId: "target" });
    busy = true;
    await messages.send("target", "Follow-up");

    expect(stub.promptCalls).toEqual([[{ type: "text", text: "First" }]]);
    expect(stub.steerCalls).toEqual([[{ type: "text", text: "Follow-up" }]]);
    expect(broadcasts).toHaveLength(2);
  });

  test("broadcasts idle sends only after durable prompt submission", async () => {
    const project = createProject("Messages", "/tmp/messages-test");
    createSession("target", project.id, { agentRuntimeType: "pi" });
    const stub = createRuntimeStub();
    const admission = Promise.withResolvers<void>();
    stub.runtime.prompt = async () => {
      await admission.promise;
      return { messageId: "entry-1" };
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

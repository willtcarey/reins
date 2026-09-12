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
    const completion = Promise.withResolvers<void>();
    const prompt = stub.runtime.prompt.bind(stub.runtime);
    stub.runtime.prompt = async (content) => { await prompt(content); await completion.promise; };
    let busy = false;
    stub.runtime.isStreaming = () => busy;
    const broadcasts: unknown[] = [];
    const messages = new SessionMessages(new Map(), (event) => { broadcasts.push(event); },
      async () => ({ id: "target", runtime: stub.runtime, lastActivity: 0 }));
    expect(await messages.send("target", "First")).toEqual({ sessionId: "target" });
    busy = true;
    await messages.send("target", "Follow-up");
    expect(stub.promptCalls).toEqual([[{ type: "text", text: "First" }]]);
    expect(stub.steerCalls).toEqual([[{ type: "text", text: "Follow-up" }]]);
    expect(broadcasts).toHaveLength(2);
    completion.resolve();
  });
});

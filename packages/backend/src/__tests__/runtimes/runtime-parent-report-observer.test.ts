import { describe, expect, test } from "bun:test";
import { attachRuntimeParentReportObserver } from "../../runtimes/runtime-parent-report-observer.js";
import { SessionMessages } from "../../models/session-messages.js";
import { createProject } from "../../project-store.js";
import { createSession } from "../../session-store.js";
import { useTestDb } from "../helpers/test-db.js";
import { createRuntimeStub } from "../helpers/test-runtime-stub.js";

describe("runtime parent reporter", () => {
  useTestDb();
  test("waits for persistence before delivery and detaches without changing persistence", async () => {
    const project = createProject("Reporter", "/tmp/reporter-test");
    createSession("parent", project.id, { agentRuntimeType: "pi" });
    createSession("child", project.id, { agentRuntimeType: "pi", parentSessionId: "parent" });
    const parent = createRuntimeStub();
    const child = createRuntimeStub({ messages: [{ role: "assistant", content: [{ type: "text", text: "Done" }] }] });
    const persisted = Promise.withResolvers<void>();
    const delivered = Promise.withResolvers<void>();
    const messages = new SessionMessages(new Map([
      ["parent", { id: "parent", runtime: parent.runtime, lastActivity: 0 }],
    ]), () => delivered.resolve());
    const detach = attachRuntimeParentReportObserver({ sessionId: "child", runtime: child.runtime,
      messages, flushPersistence: () => persisted.promise });
    child.emit({ type: "agent_end", messages: [] });
    await Promise.resolve();
    expect(parent.promptCalls).toEqual([]);
    persisted.resolve();
    await delivered.promise;
    expect(parent.promptCalls).toHaveLength(1);
    expect(JSON.stringify(parent.promptCalls)).toContain("Done");
    detach();
    child.emit({ type: "agent_end", messages: [] });
    await Promise.resolve();
    expect(parent.promptCalls).toHaveLength(1);
  });
});

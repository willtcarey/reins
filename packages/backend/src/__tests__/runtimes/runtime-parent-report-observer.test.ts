import { describe, expect, test } from "bun:test";
import { attachRuntimeParentReportObserver } from "../../runtimes/runtime-parent-report-observer.js";
import { SessionMessages } from "../../models/session-messages.js";
import { createProject } from "../../project-store.js";
import { createSession } from "../../session-store.js";
import { useTestDb } from "../helpers/test-db.js";
import { createRuntimeStub } from "../helpers/test-runtime-stub.js";

describe("runtime parent reporter", () => {
  useTestDb();

  test("reports the authoritative terminal outcome and detaches cleanly", async () => {
    const project = createProject("Reporter", "/tmp/reporter-test");
    createSession("parent", project.id, { agentRuntimeType: "pi" });
    createSession("child", project.id, { agentRuntimeType: "pi", parentSessionId: "parent" });
    const parent = createRuntimeStub();
    const child = createRuntimeStub({ messages: [{ role: "assistant", content: [{ type: "text", text: "stale success" }] }] });
    const delivered = Promise.withResolvers<void>();
    const messages = new SessionMessages(new Map([
      ["parent", { id: "parent", runtime: parent.runtime, lastActivity: 0 }],
    ]), () => delivered.resolve());
    const detach = attachRuntimeParentReportObserver({ sessionId: "child", runtime: child.runtime, messages });
    child.emit({
      type: "agent_end",
      messages: [],
      runId: "run-1",
      status: "failed",
      error: { code: "provider_error", message: "Provider unavailable" },
    });
    await delivered.promise;
    expect(parent.steerCalls).toHaveLength(1);
    const notification = parent.steerCalls[0]?.find((block) => block.type === "text")?.text;
    expect(notification).toBe("Session failed: Provider unavailable");
    expect(notification).not.toContain("stale success");
    expect(parent.steerOptions).toEqual([{ metadata: { sourceSessionId: "child" } }]);
    detach();
    child.emit({ type: "agent_end", messages: [], runId: "run-2", status: "completed" });
    await Promise.resolve();
    expect(parent.steerCalls).toHaveLength(1);
  });
});

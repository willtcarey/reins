import { describe, expect, test } from "bun:test";
import { SessionInstance } from "../../sessions/session-instance.js";
import { createProject } from "../project-fixture.js";
import { createSession, getSession } from "../session-fixture.js";
import { useTestDb } from "../helpers/test-db.js";
import { createTask } from "../../task-store.js";
import { createServerState } from "../helpers/server-state.js";
import { persistCanonicalMessages } from "../helpers/canonical-messages.js";
import { admitInput, createNodeSession, queuePrompt } from "../helpers/node-session.js";
import { nodeSessionReports } from "../../nodes/node-session-events.js";
import { useFakeNode, type FakeNode } from "../helpers/fake-node.js";

/** Steers the fake node received for a session. */
const steersTo = (node: FakeNode, sessionId: string) => node.sent.flatMap((command) => command.op === "session.steer" && command.sessionId === sessionId ? [command] : []);
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await Bun.sleep(5);
}
const reply = (text: string) => ({ role: "assistant", content: [{ type: "text" as const, text }], timestamp: 2 });
const settled = (runId: string, status: "completed" | "failed" | "aborted") => ({
  sessionId: "node", runId, reportId: crypto.randomUUID(), status, metadata: { model: null, thinkingLevel: null }, tipId: null,
});

describe("SessionInstance", () => {
  useTestDb();

  test("delivers addressed messages as steers from the sender to the target's node, without duplicate AgentHarness broadcast", async () => {
    const project = createProject("Messages", "/tmp/messages-test");
    createSession("source", project.id, { agentRuntimeType: "pi" });
    createSession("target", project.id, { agentRuntimeType: "pi" });
    // What browsers receive besides activity updates (the fake node's run starting announces one) and node status.
    const broadcasts: unknown[] = [];
    const state = createServerState();
    state.clients.add({ ws: { send: data => { const message = JSON.parse(data); if (message.type !== "session_updated" && message.type !== "node_updated") broadcasts.push(message); return 0; } } });
    const node = useFakeNode(state);
    const instance = new SessionInstance(state, "source");

    expect(await instance.send("target", "First")).toEqual({ sessionId: "target" });
    await until(() => steersTo(node, "target").length > 0);
    expect(node.sent.map((command) => command.op)).toEqual(["session.steer"]);
    expect(steersTo(node, "target")).toEqual([{ op: "session.steer", sessionId: "target", clientId: expect.any(String),
      content: [{ type: "text", text: "First" }], sourceSessionId: "source" }]);
    expect(broadcasts).toEqual([]);
  });

  test("sends to another task's session in the same project", async () => {
    const project = createProject("Cross-task delivery", "/tmp/cross-task-delivery");
    createSession("source", project.id, { agentRuntimeType: "pi" });
    const task = createTask(project.id, "Other task", null, "task/other");
    createSession("target", project.id, { agentRuntimeType: "pi", taskId: task.id });
    const state = createServerState();
    const node = useFakeNode(state);

    await new SessionInstance(state, "source").send("target", "Do not break mobile");

    await until(() => steersTo(node, "target").length > 0);
    expect(steersTo(node, "target")).toEqual([expect.objectContaining({ content: [{ type: "text", text: "Do not break mobile" }], sourceSessionId: "source" })]);
  });

  test("rejects sending to a session in another project", async () => {
    const sourceProject = createProject("Source", "/tmp/send-source");
    const targetProject = createProject("Target", "/tmp/send-target");
    createSession("source", sourceProject.id, { agentRuntimeType: "pi" });
    createSession("target", targetProject.id, { agentRuntimeType: "pi" });
    const state = createServerState();
    const node = useFakeNode(state);

    await expect(new SessionInstance(state, "source").send("target", "Nope")).rejects.toThrow();
    expect(node.sent).toEqual([]);
  });

  test("child and task sessions are created on the caller's source and prompted on its node", async () => {
    const project = createProject("Children", "/tmp/children-test");
    const caller = createSession("caller", project.id, { agentRuntimeType: "pi", modelProvider: "anthropic", modelId: "claude-sonnet-4-5" });
    const task = createTask(project.id, "Task", null, "task/children");
    const state = createServerState();
    const node = useFakeNode(state);
    const instance = new SessionInstance(state, "caller");

    const child = await instance.start("Child work", { parentSessionId: "current" });
    const taskSession = await instance.startTaskSession(task.id, "Task work");
    for (const { sessionId } of [child, taskSession]) expect(getSession(sessionId)?.source_id).toBe(caller.source_id);
    expect(getSession(child.sessionId)?.parent_session_id).toBe("caller");
    expect(getSession(taskSession.sessionId)?.task_id).toBe(task.id);
    const opsFor = (sessionId: string) => node.sent.filter((command) => command.sessionId === sessionId).map((command) => command.op);
    await until(() => [child, taskSession].every(({ sessionId }) => opsFor(sessionId).length > 0));
    expect(opsFor(child.sessionId)).toEqual(["session.prompt"]);
    expect(opsFor(taskSession.sessionId)).toEqual(["session.prompt"]);
  });

  describe("wait", () => {
    test("a child resolves with its settlement after reporting to its parent", async () => {
      const project = createProject("Node child wait", "/tmp/node-child-wait-test");
      createSession("parent", project.id, { agentRuntimeType: "pi" });
      createNodeSession("node", project.id, { parentSessionId: "parent" });
      const state = createServerState();
      const node = useFakeNode(state);
      const reports = nodeSessionReports(state);
      const command = queuePrompt("node", "client-1");
      const waiting = new SessionInstance(state, "parent").wait("node", 2000);
      admitInput(command, "client-1");
      reports.started({ sessionId: "node", runId: "run-1" });
      const tipId = persistCanonicalMessages("node", [reply("Child result")]);
      reports.settled({ ...settled("run-1", "completed"), tipId });
      expect(await waiting).toEqual({ sessionId: "node", status: "completed", result: "Child result", error: null });
      expect(getSession("node")?.activity_state).toBeNull();
      await until(() => steersTo(node, "parent").length > 0);
      expect(steersTo(node, "parent")).toEqual([expect.objectContaining({ content: [{ type: "text", text: "Child result" }], sourceSessionId: "node" })]);
    });
  });
});

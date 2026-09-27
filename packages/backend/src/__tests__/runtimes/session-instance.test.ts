import { describe, expect, test } from "bun:test";
import { getDb } from "../../db.js";
import { SessionInstance } from "../../runtimes/session-instance.js";
import { SessionManager } from "../../runtimes/session-manager.js";
import { createProject } from "../../project-store.js";
import { createSession, getSession } from "../session-fixture.js";
import { useTestDb } from "../helpers/test-db.js";
import { createTask } from "../../task-store.js";
import { createServerState } from "../helpers/server-state.js";
import { persistCanonicalMessages } from "../helpers/canonical-messages.js";
import { admitInput, createProvisionedNodeSession, queuePrompt } from "../helpers/node-session.js";
import { nodeSessionReports } from "../../runtimes/node-session-events.js";
import { claimCommand, deleteFailedCommand, settleCommand } from "../../node-command-store.js";
import { useFakeNode, type FakeNode } from "../helpers/fake-node.js";

/** Steers the fake node received for a session (sessions at rest on the server are moved onto it first). */
const steersTo = (node: FakeNode, sessionId: string) => node.sent.flatMap((command) => command.op === "session.steer" && command.sessionId === sessionId ? [command] : []);
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await Bun.sleep(5);
}
const reply = (text: string) => ({ role: "assistant", content: [{ type: "text" as const, text }], timestamp: 2 });
const settled = (runId: string, status: "completed" | "failed" | "aborted", error?: string) => ({
  sessionId: "node", runId, status, ...(error ? { error: { message: error } } : {}),
  metadata: { model: null, thinkingLevel: null }, reply: null,
});

describe("SessionInstance", () => {
  useTestDb();

  test("delivers addressed messages as steers from the sender, after moving the target onto its node, without duplicate AgentHarness broadcast", async () => {
    const project = createProject("Messages", "/tmp/messages-test");
    createSession("source", project.id, { agentRuntimeType: "pi" });
    createSession("target", project.id, { agentRuntimeType: "pi" });
    const broadcasts: unknown[] = [];
    const state = createServerState();
    const node = useFakeNode(state);
    const manager = new SessionManager(state);
    Object.defineProperty(manager, "broadcast", { value: (event: unknown) => { broadcasts.push(event); } });
    const instance = new SessionInstance(manager, "source");

    expect(await instance.send("target", "First")).toEqual({ sessionId: "target" });
    await until(() => steersTo(node, "target").length > 0);
    expect(node.sent.map((command) => command.op)).toEqual(["session.hydrate", "session.steer"]);
    expect(steersTo(node, "target")).toEqual([{ op: "session.steer", sessionId: "target", clientId: expect.any(String),
      content: [{ type: "text", text: "First" }], sourceSessionId: "source" }]);
    expect(broadcasts).toEqual([]);
  });

  test("sends to another task's session in the same project", async () => {
    const project = createProject("Cross-task delivery", "/tmp/cross-task-delivery");
    createSession("source", project.id, { agentRuntimeType: "pi" });
    const task = getDb().query<{ id: number }, [number, string, string]>(
      "INSERT INTO tasks (project_id, title, branch_name, status, created_at, updated_at) VALUES (?, ?, ?, 'open', datetime('now'), datetime('now')) RETURNING id",
    ).get(project.id, "Other task", "task/other");
    if (!task) throw new Error("Expected task");
    createSession("target", project.id, { agentRuntimeType: "pi", taskId: task.id });
    const state = createServerState();
    const node = useFakeNode(state);

    await new SessionInstance(new SessionManager(state), "source").send("target", "Do not break mobile");

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

    await expect(new SessionInstance(new SessionManager(state), "source").send("target", "Nope")).rejects.toThrow();
    expect(node.sent).toEqual([]);
  });

  test("child and task sessions started from a session at rest on the server are created for its node", async () => {
    const project = createProject("Children", "/tmp/children-test");
    const caller = createSession("caller", project.id, { agentRuntimeType: "pi", modelProvider: "anthropic", modelId: "claude-sonnet-4-5" });
    const task = createTask(project.id, "Task", null, "task/children");
    const state = createServerState();
    const node = useFakeNode(state);
    const instance = new SessionInstance(new SessionManager(state), "caller");

    const child = await instance.start("Child work", { parentSessionId: "current" });
    const taskSession = await instance.startTaskSession(task.id, "Task work");
    for (const { sessionId } of [child, taskSession]) {
      // Never at rest on the server: each was queued for provisioning on the caller's source.
      expect(getSession(sessionId)).toMatchObject({ placement_status: expect.stringMatching(/^provision(ing|ed)$/), source_id: caller.source_id });
    }
    expect(getSession(child.sessionId)?.parent_session_id).toBe("caller");
    expect(getSession(taskSession.sessionId)?.task_id).toBe(task.id);
    const opsFor = (sessionId: string) => node.sent.filter((command) => command.sessionId === sessionId).map((command) => command.op);
    await until(() => [child, taskSession].every(({ sessionId }) => getSession(sessionId)?.placement_status === "provisioned" && opsFor(sessionId).length === 2));
    expect(opsFor(child.sessionId)).toEqual(["session.provision", "session.prompt"]);
    expect(opsFor(taskSession.sessionId)).toEqual(["session.provision", "session.prompt"]);
    // The caller itself stays at rest: starting children does not move it.
    expect(getSession("caller")?.placement_status).toBe("server");
  });

  test("waiting on a session at rest on the server returns its transcript at once", async () => {
    const project = createProject("Rest wait", "/tmp/rest-wait-test");
    createSession("caller", project.id, { agentRuntimeType: "pi" });
    createSession("resting", project.id, { agentRuntimeType: "pi" });
    persistCanonicalMessages("resting", [{ role: "assistant", content: [{ type: "text", text: "Earlier answer" }], stopReason: "stop", timestamp: 1 }]);
    // A `running` kept from when the server still ran sessions is stale: nothing runs it.
    getDb().query("UPDATE sessions SET activity_state = 'running' WHERE id = 'resting'").run();
    const caller = new SessionInstance(new SessionManager(createServerState()), "caller");
    expect(await caller.wait("resting", 5_000)).toEqual({ sessionId: "resting", status: "completed", result: "Earlier answer", error: null });
  });

  test("updates activity and metadata without rewriting canonical entries", () => {
    const project = createProject("Lifecycle", "/tmp/lifecycle");
    createSession("session", project.id, { agentRuntimeType: "pi" });
    getDb().query(
      `INSERT INTO session_messages (session_id, seq, harness_id, role, message_json, created_at)
       VALUES ('session', 0, 'entry-1', 'assistant', ?, '2026-01-01T00:00:00.000Z')`,
    ).run(JSON.stringify({ type: "message", timestamp: 1, message: { role: "assistant", content: [{ type: "text", text: "canonical" }], stopReason: "stop", timestamp: 1 } }));
    const original = getDb().query<{ message_json: string }, []>("SELECT message_json FROM session_messages").get()!.message_json;
    const manager = new SessionManager(createServerState());
    const instance = new SessionInstance(manager, "session");

    instance.startedWith(() => true);
    instance.settledWith({ runId: "run-1", status: "completed" }, {
      metadata: { model: { provider: "faux", modelId: "model" }, thinkingLevel: "high" }, reply: null,
    }, () => true);

    expect(getDb().query<{ message_json: string }, []>("SELECT message_json FROM session_messages").get()!.message_json).toBe(original);
    expect(getSession("session")).toMatchObject({ activity_state: "finished", model_provider: "faux", model_id: "model", thinking_level: "high" });
  });

  test("clears child activity once its authoritative outcome is queued for the parent", async () => {
    const project = createProject("Reporter", "/tmp/reporter-test");
    createSession("parent", project.id, { agentRuntimeType: "pi" });
    createSession("child", project.id, { agentRuntimeType: "pi", parentSessionId: "parent" });
    const activity: string[] = [];
    const state = createServerState();
    const node = useFakeNode(state);
    const manager = new SessionManager(state);
    Object.defineProperty(manager, "broadcast", { value: (event: { type: string }) => {
      if (event.type !== "session_updated") return;
      const current = getSession("child")?.activity_state ?? "null";
      activity.push(current);
    } });
    const instance = new SessionInstance(manager, "child");

    instance.startedWith(() => true);
    instance.settledWith({
      runId: "run-1",
      status: "failed",
      error: { code: "provider_error", message: "Provider unavailable" },
    }, { reply: { text: "stale success", stopReason: "stop", errorMessage: null } }, () => true);
    await Bun.sleep(0);

    expect(getSession("child")?.activity_state).toBeNull();
    expect(activity).toEqual(["running", "null"]);

    await until(() => steersTo(node, "parent").length > 0);
    expect(activity).toEqual(["running", "null"]);
    expect(steersTo(node, "parent")).toEqual([expect.objectContaining({
      content: [{ type: "text", text: "Session failed: Provider unavailable" }], sourceSessionId: "child",
    })]);
  });

  test("retains finished child activity when no valid parent is available", async () => {
    const parentProject = createProject("Parent project", "/tmp/parent-project-test");
    const childProject = createProject("Child project", "/tmp/child-project-test");
    createSession("parent", parentProject.id, { agentRuntimeType: "pi" });
    createSession("child", childProject.id, { agentRuntimeType: "pi", parentSessionId: "parent" });
    const finished = Promise.withResolvers<void>();
    const manager = new SessionManager(createServerState());
    Object.defineProperty(manager, "broadcast", { value: (event: { type: string }) => {
      if (event.type === "session_updated" && getSession("child")?.activity_state === "finished") finished.resolve();
    } });
    const instance = new SessionInstance(manager, "child");

    instance.startedWith(() => true);
    instance.settledWith({ runId: "run-1", status: "completed" }, { reply: { text: "Result", stopReason: "stop", errorMessage: null } }, () => true);
    await finished.promise;

    expect(getSession("child")?.activity_state).toBe("finished");
  });

  test("clears child activity when the parent's node rejects the queued report", async () => {
    const project = createProject("Failed reporter", "/tmp/failed-reporter-test");
    createSession("parent", project.id, { agentRuntimeType: "pi" });
    createSession("child", project.id, { agentRuntimeType: "pi", parentSessionId: "parent" });
    const state = createServerState();
    const node = useFakeNode(state);
    node.reject("session.steer", "parent unavailable");
    const manager = new SessionManager(state);
    const instance = new SessionInstance(manager, "child");

    instance.startedWith(() => true);
    instance.settledWith({ runId: "run-1", status: "completed" }, { reply: { text: "Result", stopReason: "stop", errorMessage: null } }, () => true);
    for (let i = 0; i < 100 && getSession("child")?.activity_state !== null; i++) await Bun.sleep(10);

    expect(getSession("child")?.activity_state).toBeNull();
  });

  test("finishes a child without reporting to its parent when its final reply cannot be read", async () => {
    const project = createProject("Unreadable reply", "/tmp/unreadable-reply-test");
    createSession("parent", project.id, { agentRuntimeType: "pi" });
    createSession("child", project.id, { agentRuntimeType: "pi", parentSessionId: "parent" });
    const state = createServerState();
    const node = useFakeNode(state);
    const instance = new SessionInstance(new SessionManager(state), "child");

    instance.startedWith(() => true);
    instance.settledWith({ runId: "run-1", status: "completed" }, { reply: null, replyError: new Error("transcript unavailable") }, () => true);
    for (let i = 0; i < 100 && getSession("child")?.activity_state !== "finished"; i++) await Bun.sleep(5);
    await Bun.sleep(20);

    expect(getSession("child")?.activity_state).toBe("finished");
    expect(node.sent).toEqual([]);
    expect(getDb().query("SELECT COUNT(*) n FROM node_command_outbox").get()).toEqual({ n: 0 });
  });

  describe("wait for a node-owned session (durable settlement, no node runtime)", () => {
    function setup() {
      const project = createProject("Node wait", "/tmp/node-wait-test");
      createSession("caller", project.id, { agentRuntimeType: "pi" });
      createProvisionedNodeSession("node", project.id);
      const state = createServerState();
      return { state, reports: nodeSessionReports(state), caller: new SessionInstance(new SessionManager(state), "caller") };
    }

    test("resolves on the durable settlement of queued work, bridging admission before the started report", async () => {
      const { reports, caller } = setup();
      const command = queuePrompt("node", "client-1");
      expect(await caller.wait("node", 0)).toEqual({ sessionId: "node", status: "timeout", result: null, error: null });
      let done = false;
      const waiting = caller.wait("node", 2000).finally(() => { done = true; });
      admitInput(command, "client-1");
      await Bun.sleep(30);
      // Admitted, but `session.started` has not arrived: still waiting.
      expect(done).toBe(false);
      expect(getDb().query("SELECT COUNT(*) AS n FROM node_command_outbox WHERE session_id = 'node'").get()).toEqual({ n: 0 });
      reports.started({ sessionId: "node", runId: "run-1" });
      await Bun.sleep(30);
      expect(done).toBe(false);
      persistCanonicalMessages("node", [reply("Node result")]);
      reports.settled(settled("run-1", "completed"));
      expect(await waiting).toEqual({ sessionId: "node", status: "completed", result: "Node result", error: null });
      // Already settled: resolves at once from projections.
      expect(await caller.wait("node", 0)).toEqual({ sessionId: "node", status: "completed", result: "Node result", error: null });
    });

    test("returns failed and cancelled settlements and times out while running", async () => {
      const { reports, caller } = setup();
      persistCanonicalMessages("node", [reply("partial")]);
      reports.started({ sessionId: "node", runId: "run-1" });
      expect(await caller.wait("node", 20)).toEqual({ sessionId: "node", status: "timeout", result: null, error: null });
      reports.settled(settled("run-1", "failed", "Provider failed"));
      expect(await caller.wait("node", 0)).toEqual({ sessionId: "node", status: "failed", result: null, error: "Provider failed" });
      reports.started({ sessionId: "node", runId: "run-2" });
      reports.settled(settled("run-2", "aborted", "Aborted"));
      expect(await caller.wait("node", 0)).toEqual({ sessionId: "node", status: "cancelled", result: null, error: "Aborted" });
    });

    test("resolves when the run settled before its admission was recorded (the settlement covers the replica entry)", async () => {
      const { reports, caller } = setup();
      const command = queuePrompt("node", "client-1");
      claimCommand(command);
      // The node committed the input and ran it to settlement while its admission reply is in flight.
      persistCanonicalMessages("node", [{ role: "user", content: [{ type: "text", text: "Work" }], clientId: "client-1", timestamp: 1 }]);
      reports.started({ sessionId: "node", runId: "run-1" });
      persistCanonicalMessages("node", [reply("Early result")]);
      reports.settled(settled("run-1", "completed"));
      let done = false;
      const waiting = caller.wait("node", 2000).finally(() => { done = true; });
      await Bun.sleep(30);
      expect(done).toBe(false); // still dispatching
      settleCommand(command, "admitted", JSON.stringify({ ok: true, value: { kind: "admitted", inputId: "client-1" } }));
      expect(await waiting).toEqual({ sessionId: "node", status: "completed", result: "Early result", error: null });
    });

    test("a steer still queued in the replica awaits its run", async () => {
      const { reports, caller } = setup();
      persistCanonicalMessages("node", []);
      reports.started({ sessionId: "node", runId: "run-1" });
      reports.settled(settled("run-1", "completed"));
      const command = queuePrompt("node", "steer-1");
      let done = false;
      const waiting = caller.wait("node", 2000).finally(() => { done = true; });
      claimCommand(command);
      // Admitted as pending steering (Pi's pending entry), not yet moved into the transcript.
      getDb().query(`INSERT INTO pi_values (session_id, namespace, key, seq, value_json) VALUES ('node', 'pi.pending.entry', 'e1', 50, ?)`)
        .run(JSON.stringify({ type: "message", payload: { role: "reinsInput", content: [], reinsId: "steer-1", metadata: {}, timestamp: 1 } }));
      settleCommand(command, "admitted", JSON.stringify({ ok: true, value: { kind: "admitted", inputId: "steer-1" } }));
      await Bun.sleep(30);
      expect(done).toBe(false);
      getDb().query("DELETE FROM pi_values WHERE namespace = 'pi.pending.entry'").run();
      persistCanonicalMessages("node", [{ role: "user", content: [{ type: "text", text: "Steer" }], clientId: "steer-1", timestamp: 1 }]);
      reports.started({ sessionId: "node", runId: "run-2" });
      persistCanonicalMessages("node", [reply("Steered")]);
      reports.settled(settled("run-2", "completed"));
      expect(await waiting).toEqual({ sessionId: "node", status: "completed", result: "Steered", error: null });
    });

    test("an input that failed delivery expects no run; a failed provision fails the wait", async () => {
      const { caller } = setup();
      persistCanonicalMessages("node", []);
      const command = queuePrompt("node", "client-1");
      const waiting = caller.wait("node", 2000);
      claimCommand(command);
      settleCommand(command, "failed", JSON.stringify({ ok: false, error: { code: "invalid_request", message: "rejected", retryable: false } }));
      deleteFailedCommand(command);
      expect(await waiting).toEqual({ sessionId: "node", status: "idle", result: null, error: null });
      getDb().query("UPDATE sessions SET placement_status = 'provision_failed', status_error = 'Model not found' WHERE id = 'node'").run();
      expect(await caller.wait("node", 0)).toEqual({ sessionId: "node", status: "failed", result: null, error: "Session provisioning failed: Model not found" });
    });

    test("a child resolves with its settlement after reporting to its parent", async () => {
      const project = createProject("Node child wait", "/tmp/node-child-wait-test");
      createSession("parent", project.id, { agentRuntimeType: "pi" });
      createProvisionedNodeSession("node", project.id, { parentSessionId: "parent" });
      const state = createServerState();
      const node = useFakeNode(state);
      const reports = nodeSessionReports(state);
      const command = queuePrompt("node", "client-1");
      const waiting = new SessionInstance(new SessionManager(state), "parent").wait("node", 2000);
      admitInput(command, "client-1");
      reports.started({ sessionId: "node", runId: "run-1" });
      persistCanonicalMessages("node", [reply("Child result")]);
      reports.settled({ ...settled("run-1", "completed"), reply: { text: "Child result", stopReason: "stop", errorMessage: null } });
      expect(await waiting).toEqual({ sessionId: "node", status: "completed", result: "Child result", error: null });
      expect(getSession("node")?.activity_state).toBeNull();
      await until(() => steersTo(node, "parent").length > 0);
      expect(steersTo(node, "parent")).toEqual([expect.objectContaining({ content: [{ type: "text", text: "Child result" }], sourceSessionId: "node" })]);
    });
  });
});

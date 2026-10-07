import { describe, test, expect, spyOn } from "bun:test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { getDb } from "../../db.js";
import { setApiKeyCredential } from "../../auth-credentials-store.js";
import { createProject } from "../project-fixture.js";
import { createSession, getSession } from "../session-fixture.js";
import { useTestDb } from "../helpers/test-db.js";
import { createServerState } from "../helpers/server-state.js";
import { useTestRepo } from "../helpers/test-repo.js";
import { Sessions } from "../../models/sessions.js";
import { registerPiProvider, unregisterPiProvider } from "../helpers/pi-providers.js";
import { stopLoopbackNode, dialLoopback, SEEDED_NODE_ID } from "../helpers/loopback-node.js";
import type { ServerState } from "../../state.js";
import { nodeSessionReports } from "../../nodes/node-session-events.js";
import { persistCanonicalMessages } from "../helpers/canonical-messages.js";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { insertEntry } from "@earendil-works/pi-agent-core/harness/session";
import { createNodeConnection, methods, protocolVersion, type SessionSettled } from "@reins/node-protocol";
import { scriptedCommandHandlers } from "@reins/node-protocol/testing";
import { PiStorageAdapter } from "../../pi-storage.js";
import { createBroadcast, type Broadcast } from "../../models/broadcast.js";
import { claimCommand, deleteFailedCommand, settleCommand } from "../../nodes/node-command-store.js";
import { createSource, defaultSource } from "../../node-store.js";
import { createTask, setTaskStatus } from "../../task-store.js";
import { AUTO_RESUME_LIMIT, AUTO_RESUME_WINDOW_MS, createResumeBudget, latestSettlement, runInProgress, sessionRuns, type SessionRuns } from "../../sessions/session-runs.js";
import { useFakeNode, type FakeNode } from "../helpers/fake-node.js";
import { admitInput, createNodeSession, queuePrompt } from "../helpers/node-session.js";

useTestDb();

const runsFor = (state: ServerState, broadcast: Broadcast = createBroadcast(state.clients)) => sessionRuns({ broadcast, nodes: state.nodes });
const settled = (sessionId: string, runId: string, status: SessionSettled["status"] = "completed", extra: Partial<SessionSettled> = {}): SessionSettled => ({
  sessionId, runId, reportId: crypto.randomUUID(), status, metadata: { model: null, thinkingLevel: null }, tipId: null, ...extra,
});
const reply = (text: string) => ({ role: "assistant", content: [{ type: "text" as const, text }], timestamp: 2 });
/** Steers the fake node received for a session. */
const steersTo = (node: FakeNode, sessionId: string) => node.sent.flatMap(command => command.op === "session.steer" && command.sessionId === sessionId ? [command] : []);
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await Bun.sleep(5);
}

describe("run lifecycle reports", () => {
  test("a repeated start of the run in progress applies nothing; a resumed run settles again, with or without a new start", () => {
    const state = createServerState();
    const project = createProject("Lifecycle", "/tmp/lifecycle");
    createSession("parent", project.id, { agentRuntimeType: "pi" });
    createSession("child", project.id, { agentRuntimeType: "pi", parentSessionId: "parent" });
    const steers = () => getDb().query<{ n: number }, []>("SELECT COUNT(*) n FROM node_command_outbox WHERE session_id = 'parent' AND json_extract(command_json, '$.op') = 'session.steer'").get()!.n;
    const runs = runsFor(state);
    try {
      runs.runStarted("child", "r1");
      const started = getSession("child")!.updated_at;
      // Pi reports `started` again for a run in progress (in-run compaction): already applied.
      runs.runStarted("child", "r1");
      expect(getSession("child")).toMatchObject({ activity_state: "running", updated_at: started });
      expect(runInProgress("child")).toBe("r1");
      runs.runSettled(settled("child", "r1"));
      expect(steers()).toBe(1);
      expect(getSession("child")?.activity_state).toBeNull();
      expect(latestSettlement("child")).toEqual({ seq: 1, nextSeq: 1, status: "completed" });

      // Pi resumes the settled run (after it was settled as interrupted): it runs and settles again.
      runs.runStarted("child", "r1");
      expect(getSession("child")?.activity_state).toBe("running");
      runs.runSettled(settled("child", "r1"));
      expect(steers()).toBe(2);
      // A resumed run may settle without reporting a new start.
      runs.runSettled(settled("child", "r1", "failed", { error: { message: "failed on resume" } }));
      expect(latestSettlement("child")).toMatchObject({ seq: 3, status: "failed", error: { message: "failed on resume" } });
    } finally { state.nodes.close(); }
  });

  test("a settlement resent under its reportId (its reply lost) applies nothing: the parent hears of the child once", () => {
    const state = createServerState();
    const project = createProject("Resent", "/tmp/resent-settlement");
    createSession("parent", project.id, { agentRuntimeType: "pi" });
    createSession("child", project.id, { agentRuntimeType: "pi", parentSessionId: "parent" });
    const steers = () => getDb().query<{ n: number }, []>("SELECT COUNT(*) n FROM node_command_outbox WHERE session_id = 'parent' AND json_extract(command_json, '$.op') = 'session.steer'").get()!.n;
    const runs = runsFor(state);
    try {
      runs.runStarted("child", "r1");
      const report = settled("child", "r1", "completed", { reportId: "report-1" });
      runs.runSettled(report);
      runs.runSettled(report);
      expect(steers()).toBe(1);
      expect(latestSettlement("child")).toMatchObject({ seq: 1, status: "completed" });
    } finally { state.nodes.close(); }
  });

  test("settlement persists the run's model metadata without rewriting canonical entries, and marks a top-level session finished", () => {
    const project = createProject("Metadata", "/tmp/metadata");
    createSession("session", project.id, { agentRuntimeType: "pi" });
    persistCanonicalMessages("session", [reply("canonical")]);
    const original = getDb().query<{ message_json: string }, []>("SELECT message_json FROM session_messages").get()!.message_json;
    const runs = runsFor(createServerState());

    runs.runStarted("session", "run-1");
    runs.runSettled(settled("session", "run-1", "completed", { metadata: { model: { provider: "faux", modelId: "model" }, thinkingLevel: "high" } }));

    expect(getDb().query<{ message_json: string }, []>("SELECT message_json FROM session_messages").get()!.message_json).toBe(original);
    expect(getSession("session")).toMatchObject({ activity_state: "finished", model_provider: "faux", model_id: "model", thinking_level: "high" });
  });

  test("a run in flight when its task closes settles without unread activity; a run resumed after the close settles unread", async () => {
    const project = createProject("Closing", "/tmp/closing-task");
    const task = createTask(project.id, "Closing task", null, "task/closing");
    createSession("session", project.id, { agentRuntimeType: "pi", taskId: task.id });
    const runs = runsFor(createServerState());

    runs.runStarted("session", "run-1");
    setTaskStatus(task.id, "closed");
    runs.runSettled(settled("session", "run-1"));
    expect(getSession("session")?.activity_state).toBeNull();

    await Bun.sleep(2);
    runs.runStarted("session", "run-2");
    runs.runSettled(settled("session", "run-2"));
    expect(getSession("session")?.activity_state).toBe("finished");
  });

  test("a delayed child settlement reports its completed branch, not a newer main tip; an unreadable reply finishes the child without reporting", async () => {
    const state = createServerState();
    const project = createProject("Replies", "/tmp/replies");
    createSession("parent", project.id, { agentRuntimeType: "pi" });
    createSession("child", project.id, { agentRuntimeType: "pi", parentSessionId: "parent" });
    const storage = new PiStorageAdapter(getDb(), "child");
    await storage.commit([
      insertEntry({ id: "completed", parentId: null, type: "message", message: fauxAssistantMessage("First answer") }),
      insertEntry({ id: "newer", parentId: "completed", type: "message", message: fauxAssistantMessage("Newer answer") }),
      { kind: "value", op: "set", namespace: "pi.branch.tip", key: "main", value: "newer" },
    ], BACKGROUND_CONTEXT);
    const runs = runsFor(state);
    const inputs = () => getDb().query<{ command_json: string }, []>("SELECT command_json FROM node_command_outbox WHERE session_id = 'parent' ORDER BY rowid").all().map(row => JSON.parse(row.command_json).content);
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      runs.runSettled(settled("child", "r", "completed", { tipId: "completed" }));
      expect(inputs()).toEqual([[{ type: "text", text: "First answer" }]]);
      runs.runSettled(settled("child", "r", "completed", { tipId: "unknown" }));
      expect(inputs()).toHaveLength(1);
      expect(getSession("child")?.activity_state).toBe("finished");
      expect(latestSettlement("child")).toMatchObject({ seq: 2, status: "completed" });
      expect(errors).toHaveBeenCalled();
    } finally { errors.mockRestore(); state.nodes.close(); }
  });

  test("a child's failure reaches its parent's node as a steer; its activity clears as the report is queued", async () => {
    const project = createProject("Reporter", "/tmp/reporter-test");
    createSession("parent", project.id, { agentRuntimeType: "pi" });
    createSession("child", project.id, { agentRuntimeType: "pi", parentSessionId: "parent" });
    const activity: string[] = [];
    const state = createServerState();
    const node = useFakeNode(state);
    const runs = runsFor(state, event => { if (event.type === "session_updated") activity.push(getSession("child")?.activity_state ?? "null"); });

    runs.runStarted("child", "run-1");
    runs.runSettled(settled("child", "run-1", "failed", { error: { code: "provider_error", message: "Provider unavailable" } }));
    expect(getSession("child")?.activity_state).toBeNull();
    expect(activity).toEqual(["running", "null"]);

    await until(() => steersTo(node, "parent").length > 0);
    expect(steersTo(node, "parent")).toEqual([expect.objectContaining({
      content: [{ type: "text", text: "Session failed: Provider unavailable" }], sourceSessionId: "child",
    })]);
    // A rejected report does not bring the child's activity back.
    node.reject("session.steer", "parent unavailable");
    runs.runSettled(settled("child", "run-2"));
    await until(() => steersTo(node, "parent").length > 1);
    expect(getSession("child")?.activity_state).toBeNull();
  });

  test("a child whose parent is outside its project stays finished and reports nothing", () => {
    const parentProject = createProject("Parent project", "/tmp/parent-project-test");
    const childProject = createProject("Child project", "/tmp/child-project-test");
    createSession("parent", parentProject.id, { agentRuntimeType: "pi" });
    createSession("child", childProject.id, { agentRuntimeType: "pi", parentSessionId: "parent" });
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      runsFor(createServerState()).runSettled(settled("child", "run-1"));
      expect(getSession("child")?.activity_state).toBe("finished");
      expect(getDb().query("SELECT COUNT(*) n FROM node_command_outbox").get()).toEqual({ n: 0 });
    } finally { errors.mockRestore(); }
  });

  /** Sessions `cut`, `live` (listed live by the node) and `elsewhere` (on another node) running, `idle` not. */
  function lostRunFixture() {
    const state = createServerState();
    const project = createProject("Interrupted", "/tmp/interrupted");
    getDb().exec("INSERT INTO nodes (id, name) VALUES ('remote', 'Remote')");
    const local = defaultSource(project.id)!.id;
    const remote = createSource(project.id, "remote", "/tmp/interrupted-remote").id;
    const runs = runsFor(state);
    for (const [id, sourceId] of [["cut", local], ["live", local], ["elsewhere", remote]] as const) {
      createSession(id, project.id, { agentRuntimeType: "pi", sourceId });
      runs.runStarted(id, `${id}-run`);
    }
    createSession("idle", project.id, { agentRuntimeType: "pi", sourceId: local });
    return { state, project, local, runs };
  }
  /** A scripted node announcing `liveSessions`, answering `session.resumePending` with `resume`. */
  const dialResumingNode = (state: ServerState, resume: (sessionId: string) => Promise<{ started: boolean }>, liveSessions: string[] = []) =>
    dialLoopback(state, socket => createNodeConnection(socket, {
      nodeId: SEEDED_NODE_ID, minVersion: protocolVersion, maxVersion: protocolVersion, capabilities: [methods.sessionResumePending], liveSessions,
      maxFrameBytes: Infinity, ...scriptedCommandHandlers({ resumePending: async ({ sessionId }) => resume(sessionId) }),
    }), { redial: false });

  test("a node's hello resumes every run the server sees running on it that the node does not list as live; the session stays running", async () => {
    const { state } = lostRunFixture();
    const resumed: string[] = [];
    const link = dialResumingNode(state, async sessionId => { resumed.push(sessionId); return { started: true }; }, ["live"]);
    try {
      await link.ready();
      await until(() => resumed.length === 1);
      await Bun.sleep(20);
      expect(resumed).toEqual(["cut"]);
      expect(runInProgress("cut")).toBe("cut-run");
      expect(["cut", "live", "elsewhere"].map(id => getSession(id)?.activity_state)).toEqual(["running", "running", "running"]);
      expect(["cut", "live", "elsewhere", "idle"].map(latestSettlement)).toEqual([null, null, null, null]);
      expect(getSession("idle")?.activity_state).toBeNull();
    } finally { link.stop(); state.nodes.close(); }
  });

  test("a lost run is settled as interrupted when its resume finds nothing pending or fails; a run that settled meanwhile is left alone", async () => {
    const { state, project, local, runs } = lostRunFixture();
    createSession("refused", project.id, { agentRuntimeType: "pi", sourceId: local });
    runs.runStarted("refused", "refused-run");
    createSession("settles", project.id, { agentRuntimeType: "pi", sourceId: local });
    runs.runStarted("settles", "settles-run");
    const link = dialResumingNode(state, async sessionId => {
      if (sessionId === "refused") throw new Error("model unavailable");
      // The run's settlement arrives while the server asks; nothing is left to resume.
      if (sessionId === "settles") runs.runSettled(settled("settles", "settles-run"));
      return { started: false };
    }, ["live"]);
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      await link.ready();
      await until(() => latestSettlement("cut") !== null && latestSettlement("refused") !== null);
      for (const id of ["cut", "refused"]) {
        expect(latestSettlement(id)).toMatchObject({ status: "failed", error: { message: expect.stringContaining("The run was interrupted") } });
        expect(getSession(id)?.activity_state).not.toBe("running");
        // The run is no longer in progress: Pi may resume it under its ID later, and that start applies.
        expect(runInProgress(id)).toBeNull();
      }
      await Bun.sleep(20);
      expect(latestSettlement("settles")).toMatchObject({ seq: 1, status: "completed" });
      expect(getSession("live")?.activity_state).toBe("running");
    } finally { errors.mockRestore(); link.stop(); state.nodes.close(); }
  });

  test(`a session that keeps losing its run is resumed at most ${AUTO_RESUME_LIMIT} times within ${AUTO_RESUME_WINDOW_MS / 60_000} minutes, then settled as interrupted`, async () => {
    const { state } = lostRunFixture();
    let resumes = 0;
    const resume = async () => { resumes++; return { started: true }; };
    try {
      for (let hello = 1; hello <= AUTO_RESUME_LIMIT; hello++) {
        const link = dialResumingNode(state, resume, ["live"]);
        await link.ready();
        await until(() => resumes === hello);
        link.stop();
        expect(getSession("cut")?.activity_state).toBe("running");
      }
      const link = dialResumingNode(state, resume, ["live"]);
      await link.ready();
      await until(() => latestSettlement("cut") !== null);
      expect(resumes).toBe(AUTO_RESUME_LIMIT);
      expect(latestSettlement("cut")).toMatchObject({ status: "failed", error: { message: expect.stringContaining("The run was interrupted") } });
      link.stop();
    } finally { state.nodes.close(); }
  });

  test("the resume budget counts each session's automatic resumes within a sliding window", () => {
    let now = 0;
    const budget = createResumeBudget({ limit: 2, windowMs: 1_000, now: () => now });
    expect([budget.take("a"), budget.take("a"), budget.take("a"), budget.take("b")]).toEqual([true, true, false, true]);
    now = 999;
    expect(budget.take("a")).toBe(false);
    now = 1_000;
    expect([budget.take("a"), budget.take("a"), budget.take("a")]).toEqual([true, true, false]);
  });
});

/** Waits for session "node". */
const wait = (runs: SessionRuns, timeoutMs: number) => runs.waitForSettlement("node", timeoutMs);

describe("waitForSettlement (durable settlement, no node runtime)", () => {
  function setup() {
    const project = createProject("Node wait", "/tmp/node-wait-test");
    createNodeSession("node", project.id);
    return runsFor(createServerState());
  }

  test("resolves on the durable settlement of queued work, bridging admission before the started report", async () => {
    const runs = setup();
    const command = queuePrompt("node", "client-1");
    expect(await wait(runs, 0)).toEqual({ sessionId: "node", status: "timeout", result: null, error: null });
    let done = false;
    const waiting = wait(runs, 2000).finally(() => { done = true; });
    admitInput(command, "client-1");
    await Bun.sleep(30);
    // Admitted, but `session.started` has not arrived: still waiting.
    expect(done).toBe(false);
    expect(getDb().query("SELECT COUNT(*) AS n FROM node_command_outbox WHERE session_id = 'node'").get()).toEqual({ n: 0 });
    runs.runStarted("node", "run-1");
    await Bun.sleep(30);
    expect(done).toBe(false);
    persistCanonicalMessages("node", [reply("Node result")]);
    runs.runSettled(settled("node", "run-1"));
    expect(await waiting).toEqual({ sessionId: "node", status: "completed", result: "Node result", error: null });
    // Already settled: resolves at once from projections.
    expect(await wait(runs, 0)).toEqual({ sessionId: "node", status: "completed", result: "Node result", error: null });
  });

  test("returns failed and cancelled settlements, times out while running and rejects when aborted", async () => {
    const runs = setup();
    persistCanonicalMessages("node", [reply("partial")]);
    runs.runStarted("node", "run-1");
    expect(await wait(runs, 20)).toEqual({ sessionId: "node", status: "timeout", result: null, error: null });
    const controller = new AbortController();
    const aborted = runs.waitForSettlement("node", 2000, controller.signal);
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
    runs.runSettled(settled("node", "run-1", "failed", { error: { message: "Provider failed" } }));
    expect(await wait(runs, 0)).toEqual({ sessionId: "node", status: "failed", result: null, error: "Provider failed" });
    runs.runStarted("node", "run-2");
    runs.runSettled(settled("node", "run-2", "aborted", { error: { message: "Aborted" } }));
    expect(await wait(runs, 0)).toEqual({ sessionId: "node", status: "cancelled", result: null, error: "Aborted" });
  });

  test("resolves when the run settled before its admission was recorded (the settlement covers the stored entry)", async () => {
    const runs = setup();
    const command = queuePrompt("node", "client-1");
    claimCommand(command);
    // The node committed the input and ran it to settlement while its admission reply is in flight.
    persistCanonicalMessages("node", [{ role: "user", content: [{ type: "text", text: "Work" }], clientId: "client-1", timestamp: 1 }]);
    runs.runStarted("node", "run-1");
    persistCanonicalMessages("node", [reply("Early result")]);
    runs.runSettled(settled("node", "run-1"));
    let done = false;
    const waiting = wait(runs, 2000).finally(() => { done = true; });
    await Bun.sleep(30);
    expect(done).toBe(false); // still dispatching
    settleCommand(command, "admitted", JSON.stringify({ ok: true, value: { inputId: "client-1" } }));
    expect(await waiting).toEqual({ sessionId: "node", status: "completed", result: "Early result", error: null });
  });

  test("a steer still queued in storage awaits its run", async () => {
    const runs = setup();
    persistCanonicalMessages("node", []);
    runs.runStarted("node", "run-1");
    runs.runSettled(settled("node", "run-1"));
    const command = queuePrompt("node", "steer-1");
    let done = false;
    const waiting = wait(runs, 2000).finally(() => { done = true; });
    claimCommand(command);
    // Admitted as pending steering (Pi's pending entry), not yet moved into the transcript.
    getDb().query(`INSERT INTO pi_values (session_id, namespace, key, seq, value_json) VALUES ('node', 'pi.pending.entry', 'e1', 50, ?)`)
      .run(JSON.stringify({ type: "message", payload: { role: "reinsInput", content: [], reinsId: "steer-1", metadata: {}, timestamp: 1 } }));
    settleCommand(command, "admitted", JSON.stringify({ ok: true, value: { inputId: "steer-1" } }));
    await Bun.sleep(30);
    expect(done).toBe(false);
    getDb().query("DELETE FROM pi_values WHERE namespace = 'pi.pending.entry'").run();
    persistCanonicalMessages("node", [{ role: "user", content: [{ type: "text", text: "Steer" }], clientId: "steer-1", timestamp: 1 }]);
    runs.runStarted("node", "run-2");
    persistCanonicalMessages("node", [reply("Steered")]);
    runs.runSettled(settled("node", "run-2"));
    expect(await waiting).toEqual({ sessionId: "node", status: "completed", result: "Steered", error: null });
  });

  test("an input that failed delivery expects no run", async () => {
    const runs = setup();
    persistCanonicalMessages("node", []);
    const command = queuePrompt("node", "client-1");
    const waiting = wait(runs, 2000);
    claimCommand(command);
    settleCommand(command, "failed", JSON.stringify({ ok: false, error: { code: "invalid_request", message: "rejected", retryable: false } }));
    deleteFailedCommand(command);
    expect(await waiting).toEqual({ sessionId: "node", status: "idle", result: null, error: null });
  });
});

describe("child settlement on a live node", () => {
  const repo = useTestRepo();
  test("automatic child settlement steers the parent on its node and retains its source in canonical parent history", async () => {
    const state = createServerState(undefined, { loopbackNode: true });
    const project = createProject("Canonical reports", repo.dir);
    const provider = fauxProvider({
      models: [{ id: "settlement-report-model", contextWindow: 200_000, maxTokens: 100 }],
    });
    const parentResponded = Promise.withResolvers<void>();
    provider.setResponses([() => {
      parentResponded.resolve();
      return fauxAssistantMessage("Report received");
    }]);
    registerPiProvider(provider.provider);
    setApiKeyCredential(provider.provider.id, "test-key");
    createSession("parent", project.id, {
      agentRuntimeType: "pi",
      modelProvider: provider.provider.id,
      modelId: "settlement-report-model",
    });
    createSession("child", project.id, { agentRuntimeType: "pi", parentSessionId: "parent" });

    try {
      nodeSessionReports(state).settled({ sessionId: "child", runId: "settled-run", reportId: "report", status: "completed", metadata: { model: null, thinkingLevel: null },
        tipId: persistCanonicalMessages("child", [{ role: "assistant", content: [{ type: "text", text: "Canonical result" }], timestamp: 2 }]) });
      await parentResponded.promise;
      // The parent's Pi lane was seeded from its row's model; the report was admitted on the node and
      // committed to the server's storage.
      const stored = () => getDb().query<{ message_json: string }, [string]>(
        "SELECT message_json FROM session_messages WHERE session_id = ? AND role = 'reinsInput'",
      ).get("parent");
      for (let i = 0; i < 200 && !stored(); i++) await Bun.sleep(5);
      expect(JSON.parse(stored()!.message_json).message).toMatchObject({
        role: "reinsInput",
        content: [{ type: "text", text: "Canonical result" }],
        metadata: { sourceSessionId: "child" },
      });
      expect(new Sessions(state.nodes).getMessagePage("parent", 10)?.items[0]?.message).toMatchObject({
        role: "user",
        content: [{ type: "text", text: "Canonical result" }],
        metadata: { sourceSessionId: "child" },
      });
      const parentSettled = () => getDb().query("SELECT 1 FROM sessions WHERE id = 'parent' AND settlement_count > 0").get();
      for (let i = 0; i < 200 && !parentSettled(); i++) await Bun.sleep(5);
    } finally {
      await stopLoopbackNode(state);
      unregisterPiProvider(provider.provider.id);
    }
  }, 15_000);
});


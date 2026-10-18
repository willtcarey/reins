import { describe, test, expect, spyOn, beforeEach } from "bun:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { insertEntry } from "@earendil-works/pi-agent-core/harness/session";
import { getDb } from "../../injected-process-state.js";
import { createProject } from "../project-fixture.js";
import { createSession, getSession } from "../session-fixture.js";
import { useTestDb } from "../helpers/test-db.js";
import { closeSessions, createAppState, stubRuntime, useLoopbackState, type TestAppState } from "../helpers/app-state.js";
import { useTestRepo } from "../helpers/test-repo.js";
import { useFakeModel } from "../helpers/fake-model.js";
import { sessionHost, until } from "../helpers/session-host.js";
import { Sessions } from "../../models/sessions.js";
import { persistCanonicalMessages } from "../helpers/canonical-messages.js";
import { PiStorageAdapter } from "../../pi-storage.js";
import { storedInput } from "../../pi-session-store.js";
import { createTask, setTaskStatus } from "../../task-store.js";
import { openSessionRuntime } from "../../session-runtime/live.js";
import { readPendingPiOperation } from "../../pi/run-state.js";
import type { FakeModel } from "../helpers/fake-model.js";
import { AUTO_RESUME_LIMIT, latestSettlement, runSettled, sessionRuns, takeAutoResume, type SessionSettled } from "../../sessions/session-runs.js";

useTestDb();

/** `state`'s runs, with its process's run ends as a runtime applies them (`runSettled`). */
const runsFor = (state: TestAppState) => ({
  ...sessionRuns(state),
  runSettled: (report: SessionSettled) => runSettled(state.process, report),
});
type Runs = ReturnType<typeof runsFor>;
const settled = (sessionId: string, runId: string, status: SessionSettled["status"] = "completed", extra: Partial<SessionSettled> = {}): SessionSettled => ({
  sessionId, runId, source: "pi", status, metadata: { model: null, thinkingLevel: null }, tipId: null, ...extra,
});
/** Pi's record of operation `operationId` of the session ending, started at `startedAt` (ms). */
const piResult = (sessionId: string, operationId: string, startedAt: number) => getDb()
  .query("INSERT INTO pi_values (session_id, namespace, key, seq, value_json) VALUES (?, 'pi.result', ?, 1, ?)")
  .run(sessionId, operationId, JSON.stringify({ operationId, kind: "run", status: "completed", fromTipId: null, tipId: null, startedAt, endedAt: startedAt }));
/** The last run end Reins applied to the session, as its row records it. */
const settlementRecord = (sessionId: string): unknown => JSON.parse(getDb().query<{ settlement_json: string }, [string]>("SELECT settlement_json FROM sessions WHERE id = ?").get(sessionId)!.settlement_json);
const reply = (text: string) => ({ role: "assistant", content: [{ type: "text" as const, text }], timestamp: 2 });
/** The inputs Pi admitted for `sessionId` (transcript entries and queued steering), with their text. */
const inputsOf = (sessionId: string) => [
  ...getDb().query<{ json: string }, [string]>("SELECT json_extract(message_json, '$.message') json FROM session_messages WHERE session_id = ? AND role = 'reinsInput' ORDER BY seq").all(sessionId),
  ...getDb().query<{ json: string }, [string]>("SELECT json_extract(value_json, '$.payload') json FROM pi_values WHERE session_id = ? AND namespace = 'pi.pending.entry' AND json_extract(value_json, '$.payload.role') = 'reinsInput' ORDER BY seq").all(sessionId),
].map(({ json }) => {
  const message: { reinsId: string; content: Array<{ text?: string }>; metadata: Record<string, unknown> } = JSON.parse(json);
  return { reinsId: message.reinsId, text: message.content.map(block => block.text).join(""), metadata: message.metadata };
});

/** Session `id` (already created) with a run its runtime left pending in storage, as a SIGTERM leaves it
 * (suspended). */
async function interruptRun(state: TestAppState, model: FakeModel, id: string): Promise<void> {
  await new Sessions(state, () => {}).submit(id, { op: "prompt", content: [{ type: "text", text: "Work" }], clientId: `${id}-work` });
  await model.nextTurn(id);
  const entry = state.process.sessions.live.get(id)!;
  state.process.sessions.live.delete(id);
  await entry.runtime.suspend();
}

describe("run lifecycle reports", () => {
  test("a run's end is recorded with Pi's operation and who ended it; the same operation may end again (resumed after a give-up)", async () => {
    const state = createAppState();
    const project = createProject("Lifecycle", "/tmp/lifecycle");
    createSession("session", project.id, { agentRuntimeType: "pi" });
    const runs = runsFor(state);
    await runs.runSettled(settled("session", "r1", "failed", { source: "reins", error: { message: "The run was interrupted: the server restarted" } }));
    expect(settlementRecord("session")).toEqual({ operationId: "r1", source: "reins", status: "failed", error: { message: "The run was interrupted: the server restarted" } });
    await runs.runSettled(settled("session", "r1"));
    expect(latestSettlement("session")).toEqual({ seq: 2, nextSeq: 1, status: "completed" });
    expect(settlementRecord("session")).toEqual({ operationId: "r1", source: "pi", status: "completed" });
    // Nothing durable says it runs.
    expect(getDb().query("SELECT run_id, run_started_at FROM sessions WHERE id = 'session'").get()).toEqual({ run_id: null, run_started_at: null });
  });

  test("settlement persists the run's model metadata without rewriting canonical entries, and marks a top-level session finished", async () => {
    const project = createProject("Metadata", "/tmp/metadata");
    createSession("session", project.id, { agentRuntimeType: "pi" });
    persistCanonicalMessages("session", [reply("canonical")]);
    const original = getDb().query<{ message_json: string }, []>("SELECT message_json FROM session_messages").get()!.message_json;
    const runs = runsFor(createAppState());

    await runs.runSettled(settled("session", "run-1", "completed", { metadata: { model: { provider: "faux", modelId: "model" }, thinkingLevel: "high" } }));

    expect(getDb().query<{ message_json: string }, []>("SELECT message_json FROM session_messages").get()!.message_json).toBe(original);
    expect(getSession("session")).toMatchObject({ activity_state: "finished", model_provider: "faux", model_id: "model", thinking_level: "high" });
  });

  test("a run Pi started before its task closed settles without unread activity, a give-up of one too; a run started after the close settles unread", async () => {
    const project = createProject("Closing", "/tmp/closing-task");
    const task = createTask(project.id, "Closing task", null, "task/closing");
    createSession("session", project.id, { agentRuntimeType: "pi", taskId: task.id });
    const runs = runsFor(createAppState());

    piResult("session", "run-1", Date.now());
    // Still in progress in Pi when Reins gives it up.
    getDb().query("INSERT INTO pi_values (session_id, namespace, key, seq, value_json) VALUES ('session', 'pi.lane.state', 'main', 1, ?), ('session', 'pi.op.meta', 'run-2', 1, ?)")
      .run(JSON.stringify({ currentOperationId: "run-2", lastOperationId: "run-1", inbox: [] }), JSON.stringify({ operationId: "run-2", lane: "main", sourceTipId: null, startedAt: Date.now(), intent: { kind: "run", promptEntryIds: [] } }));
    await Bun.sleep(2);
    setTaskStatus(task.id, "closed");
    await runs.runSettled(settled("session", "run-1"));
    expect(getSession("session")?.activity_state).toBeNull();
    await runs.runSettled(settled("session", "run-2", "failed", { source: "reins", error: { message: "interrupted" } }));
    expect(getSession("session")?.activity_state).toBeNull();

    await Bun.sleep(2);
    piResult("session", "run-3", Date.now());
    await runs.runSettled(settled("session", "run-3"));
    expect(getSession("session")?.activity_state).toBe("finished");
  });
});

describe("a child's report to its parent", () => {
  const repo = useTestRepo();
  const loopback = useLoopbackState();
  const model = useFakeModel();
  let runs: Runs;
  let project: ReturnType<typeof createProject>;

  beforeEach(() => {
    project = createProject("Reports", repo.dir);
    createSession("parent", project.id, { agentRuntimeType: "pi", ...modelOf() });
    createSession("child", project.id, { agentRuntimeType: "pi", parentSessionId: "parent", ...modelOf() });
    runs = runsFor(loopback.state);
  });
  const modelOf = () => ({ modelProvider: model.model.provider, modelId: model.model.modelId });

  test("steers the parent first, under a key of the child and its run (Pi's operation ID), then commits the settlement and clears the child's activity", async () => {
    // The child's settlements applied when its parent was steered (through its live runtime).
    const parent = await openSessionRuntime(loopback.state.process, "parent");
    const steer = parent.steer.bind(parent);
    const settlementsAtSteer: number[] = [];
    spyOn(parent, "steer").mockImplementation((...args) => {
      settlementsAtSteer.push(latestSettlement("child")?.seq ?? 0);
      return steer(...args);
    });
    await runs.runSettled(settled("child", "run-1", "failed", { error: { code: "provider_error", message: "Provider unavailable" } }));
    expect(settlementsAtSteer).toEqual([0]);
    expect(inputsOf("parent")).toEqual([{ reinsId: "child-report:child:run-1", text: "Session failed: Provider unavailable", metadata: { sourceSessionId: "child" } }]);
    expect(latestSettlement("child")).toMatchObject({ seq: 1, status: "failed" });
    expect(getSession("child")?.activity_state).toBeNull();

    // The parent's runtime runs the report: Pi frames it as coming from the child.
    const turn = await model.nextTurn("parent");
    expect(JSON.stringify(turn.context.messages)).toContain("Reins session update from session child");
    turn.finish();

    persistCanonicalMessages("child", [reply("Second answer")]);
    const tipId = getDb().query<{ harness_id: string }, []>("SELECT harness_id FROM session_messages WHERE session_id = 'child' ORDER BY seq DESC LIMIT 1").get()!.harness_id;
    await runs.runSettled(settled("child", "run-2", "completed", { tipId }));
    expect(inputsOf("parent").map(input => input.reinsId)).toEqual(["child-report:child:run-1", "child-report:child:run-2"]);
    // A run Reins ends itself (given up, or its storage failed) reports under its own key: the same
    // operation may still end in Pi after a resume, and that report is another.
    await runs.runSettled(settled("child", "run-3", "failed", { source: "reins", error: { message: "The run was interrupted: the server restarted" } }));
    expect(inputsOf("parent").at(-1)?.reinsId).toBe("child-report:child:run-3:interrupted");
    expect(settlementRecord("child")).toEqual({ operationId: "run-3", source: "reins", status: "failed", error: { message: "The run was interrupted: the server restarted" } });
    expect(inputsOf("parent")[1]?.text).toBe("Second answer");
  });

  test("a crash between the two steps (the steer committed, the settlement not): recovery does not report the run again", async () => {
    // Pi ended the child's run and its report reached the parent, but the settlement never applied: Pi
    // has nothing pending, so recovery leaves it alone (its effects are lost).
    await new Sessions(loopback.state, () => {}).submit("parent", { op: "steer", content: [{ type: "text", text: "Child result" }], clientId: "child-report:child:run-1", sourceSessionId: "child" });
    // A run that code before the operation-ID key gave up on, its report steered under the settlement's
    // count: its operation is still pending in Pi, and recovery gives it up again (its budget is spent).
    createSession("legacy", project.id, { agentRuntimeType: "pi", parentSessionId: "parent", ...modelOf() });
    await interruptRun(loopback.state, model, "legacy");
    for (let resume = 0; resume < AUTO_RESUME_LIMIT; resume++) takeAutoResume("legacy");
    await new Sessions(loopback.state, () => {}).submit("parent", { op: "steer", content: [{ type: "text", text: "Session failed: interrupted" }], clientId: "child-report:legacy:1", sourceSessionId: "legacy" });

    await runs.recoverInterruptedRuns();
    expect(latestSettlement("child")).toBeNull();
    expect(settlementRecord("legacy")).toMatchObject({ source: "reins", status: "failed" });
    expect(getSession("legacy")?.activity_state).toBeNull();
    expect(inputsOf("parent").map(input => input.reinsId)).toEqual(["child-report:child:run-1", "child-report:legacy:1"]);
  });

  test("a delayed settlement reports its completed branch, not a newer main tip; an unreadable reply finishes the child without reporting", async () => {
    const storage = new PiStorageAdapter(getDb(), "child");
    await storage.commit([
      insertEntry({ id: "completed", parentId: null, type: "message", message: fauxAssistantMessage("First answer") }),
      insertEntry({ id: "newer", parentId: "completed", type: "message", message: fauxAssistantMessage("Newer answer") }),
      { kind: "value", op: "set", namespace: "pi.branch.tip", key: "main", value: "newer" },
    ], BACKGROUND_CONTEXT);
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      await runs.runSettled(settled("child", "r", "completed", { tipId: "completed" }));
      expect(inputsOf("parent").map(input => input.text)).toEqual(["First answer"]);
      await runs.runSettled(settled("child", "r", "completed", { tipId: "unknown" }));
      expect(inputsOf("parent")).toHaveLength(1);
      expect(getSession("child")?.activity_state).toBe("finished");
      expect(latestSettlement("child")).toMatchObject({ seq: 2, status: "completed" });
      expect(errors).toHaveBeenCalled();
    } finally { errors.mockRestore(); }
  });

  test("a parent that cannot receive the report (its model is gone, or it is outside the child's project) leaves the child finished, with nothing reported", async () => {
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      getDb().query("UPDATE sessions SET model_id = 'missing' WHERE id = 'parent'").run();
      await runs.runSettled(settled("child", "run-1"));
      expect(getSession("child")?.activity_state).toBe("finished");
      expect(latestSettlement("child")).toMatchObject({ seq: 1, status: "completed" });

      const other = createProject("Other", `${repo.dir}/other`);
      createSession("stranger", other.id, { agentRuntimeType: "pi", parentSessionId: "parent", ...modelOf() });
      getDb().query("UPDATE sessions SET model_id = 'fake' WHERE id = 'parent'").run();
      await runs.runSettled(settled("stranger", "run-1"));
      expect(getSession("stranger")?.activity_state).toBe("finished");
      expect(inputsOf("parent")).toEqual([]);
      expect(errors).toHaveBeenCalledTimes(2);
    } finally { errors.mockRestore(); }
  });
});

describe("with no app (a reload's gap)", () => {
  const repo = useTestRepo();
  const model = useFakeModel();

  test("a run's settlement updates the row and broadcasts at once; a child's report steers its parent through Pi", async () => {
    const host = sessionHost();
    const updates = (sessionId: string) => host.frames.map(frame => JSON.parse(frame)).filter(frame => frame.type === "session_updated" && frame.sessionId === sessionId);
    try {
      const project = createProject("Gap", repo.dir);
      const modelOf = { modelProvider: model.model.provider, modelId: model.model.modelId };
      createSession("parent", project.id, { agentRuntimeType: "pi", ...modelOf });
      createSession("child", project.id, { agentRuntimeType: "pi", parentSessionId: "parent", ...modelOf });
      expect(host.app).toBeUndefined();

      await runSettled(host, settled("child", "run-1", "failed", { error: { message: "Provider unavailable" } }));
      // Pi admitted it on the parent's lane under the report's key.
      expect(inputsOf("parent")).toEqual([{ reinsId: "child-report:child:run-1", text: "Session failed: Provider unavailable", metadata: { sourceSessionId: "child" } }]);
      expect(storedInput("parent", "child-report:child:run-1")).not.toBeNull();
      expect(latestSettlement("child")).toMatchObject({ seq: 1, status: "failed" });
      expect(getSession("child")?.activity_state).toBeNull();
      expect(updates("child")).toHaveLength(1);
    } finally { await closeSessions(host); }
  });
});

describe("recovery at process start", () => {
  const repo = useTestRepo();
  const loopback = useLoopbackState();
  const model = useFakeModel();

  let project: ReturnType<typeof createProject>;
  beforeEach(() => { project = createProject("Recovery", repo.dir); });

  /** Session `id` with a run its runtime left pending in storage, as a SIGTERM leaves it (suspended). */
  async function interrupted(id: string): Promise<void> {
    createSession(id, project.id, { agentRuntimeType: "pi", modelProvider: model.model.provider, modelId: model.model.modelId });
    await interruptRun(loopback.state, model, id);
  }

  test("resumes every session Pi has a run pending for in a new runtime; it stays running and completes", async () => {
    await interrupted("cut");
    // Whatever the row says.
    getDb().query("UPDATE sessions SET activity_state = NULL WHERE id = 'cut'").run();
    await runsFor(loopback.state).recoverInterruptedRuns();
    expect(getSession("cut")?.activity_state).toBe("running");
    expect(latestSettlement("cut")).toBeNull();
    (await model.nextTurn("cut")).finish({ reply: "Resumed" });
    await until(() => latestSettlement("cut")?.status === "completed", "the resumed run completed");
    expect(storedInput("cut", "cut-work")).not.toBeNull();
  });

  test("gives up as interrupted a pending run whose resume fails and one whose resume budget is spent; leaves alone a run Pi ended, a run given up earlier and a session not running", async () => {
    const runs = runsFor(loopback.state);
    // Left running on the row (by a runtime before Pi's run state), but its run ended in Pi (the
    // settlement never applied): nothing is pending.
    createSession("ended", project.id, { agentRuntimeType: "pi", modelProvider: model.model.provider, modelId: model.model.modelId });
    getDb().query("UPDATE sessions SET activity_state = 'running', run_id = 'ended-run' WHERE id = 'ended'").run();
    // Its runtime cannot open: its kind is no longer registered.
    await interrupted("broken");
    getDb().query("UPDATE sessions SET kind = 'unregistered' WHERE id = 'broken'").run();
    // Resumed too often already.
    await interrupted("crashing");
    for (let resume = 0; resume < AUTO_RESUME_LIMIT; resume++) expect(takeAutoResume("crashing")).toBe(true);
    createSession("idle", project.id, { agentRuntimeType: "pi" });
    const operations = Object.fromEntries(["broken", "crashing"].map(id => [id, readPendingPiOperation(getDb(), id)?.operationId]));

    await runs.recoverInterruptedRuns();
    for (const id of ["broken", "crashing"]) {
      // Reins ended it, under its operation's ID; Pi still has it pending.
      expect(settlementRecord(id)).toEqual({ operationId: operations[id], source: "reins", status: "failed", error: { message: "The run was interrupted: the server restarted" } });
      expect(getSession(id)?.activity_state).toBe("finished");
      expect(readPendingPiOperation(getDb(), id)?.operationId).toBe(operations[id]!);
    }
    expect(loopback.state.process.sessions.live.has("crashing")).toBe(false);
    expect(model.turns.filter(turn => turn.sessionId === "crashing")).toHaveLength(1);
    expect(latestSettlement("ended")).toBeNull();
    // A leftover: nothing runs it.
    expect(getSession("ended")?.activity_state).toBeNull();
    expect(getSession("idle")).toMatchObject({ activity_state: null });
    expect(latestSettlement("idle")).toBeNull();

    // At the next start, the runs given up are left alone: they wait for a prompt or a resume by hand.
    await runs.recoverInterruptedRuns();
    for (const id of ["broken", "crashing"]) expect(latestSettlement(id)?.seq).toBe(1);
    expect(model.turns.filter(turn => turn.sessionId === "crashing")).toHaveLength(1);
  });

  test("the resume budget counts each session's automatic resumes within a sliding window, across processes", () => {
    createSession("a", project.id, { agentRuntimeType: "pi" });
    createSession("b", project.id, { agentRuntimeType: "pi" });
    const window = 10 * 60_000;
    expect([takeAutoResume("a", 0), takeAutoResume("a", 1), takeAutoResume("a", 2), takeAutoResume("a", 3), takeAutoResume("b", 3)]).toEqual([true, true, true, false, true]);
    expect(takeAutoResume("a", window - 1)).toBe(false);
    expect(takeAutoResume("a", window)).toBe(true);
  });
});

/** Waits for session "s". */
const wait = (runs: Runs, timeoutMs: number, inputs?: string[]) => runs.waitForSettlement("s", timeoutMs, inputs ? { inputs } : {});

describe("waitForSettlement", () => {
  /** Session "s"'s runs; its live runtime is busy while `running.now` (a run in progress). */
  function setup() {
    const project = createProject("Wait", "/tmp/wait-test");
    createSession("s", project.id, { agentRuntimeType: "pi" });
    const state = createAppState();
    const running = { now: false };
    stubRuntime(state.process, "s", { busy: () => running.now });
    return Object.assign(runsFor(state), { running });
  }

  test("resolves on the settlement of an input the caller submitted", async () => {
    const runs = setup();
    persistCanonicalMessages("s", [{ role: "user", content: [{ type: "text", text: "Work" }], clientId: "client-1", timestamp: 1 }]);
    expect(await wait(runs, 0, ["client-1"])).toEqual({ sessionId: "s", status: "timeout", result: null, error: null });
    let done = false;
    const waiting = wait(runs, 2000, ["client-1"]).finally(() => { done = true; });
    await Bun.sleep(30);
    // Admitted, but its run has not ended: still waiting.
    expect(done).toBe(false);
    runs.running.now = true;
    await Bun.sleep(30);
    expect(done).toBe(false);
    persistCanonicalMessages("s", [reply("Result")]);
    await runs.runSettled(settled("s", "run-1"));
    runs.running.now = false;
    expect(await waiting).toEqual({ sessionId: "s", status: "completed", result: "Result", error: null });
    // Already settled: resolves at once.
    expect(await wait(runs, 0, ["client-1"])).toEqual({ sessionId: "s", status: "completed", result: "Result", error: null });
  });

  test("returns failed and cancelled settlements, times out while running and rejects when aborted", async () => {
    const runs = setup();
    persistCanonicalMessages("s", [reply("partial")]);
    runs.running.now = true;
    expect(await wait(runs, 20)).toEqual({ sessionId: "s", status: "timeout", result: null, error: null });
    const controller = new AbortController();
    const aborted = runs.waitForSettlement("s", 2000, { signal: controller.signal });
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
    await runs.runSettled(settled("s", "run-1", "failed", { error: { message: "Provider failed" } }));
    runs.running.now = false;
    expect(await wait(runs, 0)).toEqual({ sessionId: "s", status: "failed", result: null, error: "Provider failed" });
    await runs.runSettled(settled("s", "run-2", "aborted", { error: { message: "Aborted" } }));
    expect(await wait(runs, 0)).toEqual({ sessionId: "s", status: "cancelled", result: null, error: "Aborted" });
  });

  test("a steer still queued in storage awaits its run; an input Pi never admitted expects none", async () => {
    const runs = setup();
    persistCanonicalMessages("s", []);
    await runs.runSettled(settled("s", "run-1"));
    expect(await wait(runs, 2000, ["never-admitted"])).toEqual({ sessionId: "s", status: "completed", result: null, error: null });
    // Admitted as pending steering (Pi's pending entry), not yet moved into the transcript.
    getDb().query(`INSERT INTO pi_values (session_id, namespace, key, seq, value_json) VALUES ('s', 'pi.pending.entry', 'e1', 50, ?)`)
      .run(JSON.stringify({ type: "message", payload: { role: "reinsInput", content: [], reinsId: "steer-1", metadata: {}, timestamp: 1 } }));
    let done = false;
    const waiting = wait(runs, 2000, ["steer-1"]).finally(() => { done = true; });
    await Bun.sleep(30);
    expect(done).toBe(false);
    getDb().query("DELETE FROM pi_values WHERE namespace = 'pi.pending.entry'").run();
    persistCanonicalMessages("s", [{ role: "user", content: [{ type: "text", text: "Steer" }], clientId: "steer-1", timestamp: 1 }]);
    persistCanonicalMessages("s", [reply("Steered")]);
    await runs.runSettled(settled("s", "run-2"));
    expect(await waiting).toEqual({ sessionId: "s", status: "completed", result: "Steered", error: null });
  });
});

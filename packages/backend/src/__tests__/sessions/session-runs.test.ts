import { describe, test, expect, spyOn, beforeEach } from "bun:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { insertEntry } from "@earendil-works/pi-agent-core/harness/session";
import { getDb } from "../../db.js";
import { createProject } from "../project-fixture.js";
import { createSession, getSession } from "../session-fixture.js";
import { useTestDb } from "../helpers/test-db.js";
import { createAppState, useLoopbackState, type TestAppState } from "../helpers/app-state.js";
import { useTestRepo } from "../helpers/test-repo.js";
import { useFakeModel } from "../helpers/fake-model.js";
import { until } from "../helpers/session-host.js";
import { Sessions } from "../../models/sessions.js";
import { persistCanonicalMessages } from "../helpers/canonical-messages.js";
import { PiStorageAdapter } from "../../pi-storage.js";
import { createBroadcast, type Broadcast } from "../../models/broadcast.js";
import { storedInput } from "../../pi-session-store.js";
import { createTask, setTaskStatus } from "../../task-store.js";
import { AUTO_RESUME_LIMIT, latestSettlement, runInProgress, sessionRuns, takeAutoResume, type SessionRuns, type SessionSettled } from "../../sessions/session-runs.js";

useTestDb();

const runsFor = (state: TestAppState, broadcast: Broadcast = createBroadcast(state.process)) => sessionRuns({ broadcast, state });
const settled = (sessionId: string, runId: string, status: SessionSettled["status"] = "completed", extra: Partial<SessionSettled> = {}): SessionSettled => ({
  sessionId, runId, reportId: crypto.randomUUID(), status, metadata: { model: null, thinkingLevel: null }, tipId: null, ...extra,
});
const reply = (text: string) => ({ role: "assistant", content: [{ type: "text" as const, text }], timestamp: 2 });
/** The inputs Pi admitted for `sessionId` (transcript entries and queued steering), with their text. */
const inputsOf = (sessionId: string) => [
  ...getDb().query<{ json: string }, [string]>("SELECT json_extract(message_json, '$.message') json FROM session_messages WHERE session_id = ? AND role = 'reinsInput' ORDER BY seq").all(sessionId),
  ...getDb().query<{ json: string }, [string]>("SELECT json_extract(value_json, '$.payload') json FROM pi_values WHERE session_id = ? AND namespace = 'pi.pending.entry' AND json_extract(value_json, '$.payload.role') = 'reinsInput' ORDER BY seq").all(sessionId),
].map(({ json }) => {
  const message: { reinsId: string; content: Array<{ text?: string }>; metadata: Record<string, unknown> } = JSON.parse(json);
  return { reinsId: message.reinsId, text: message.content.map(block => block.text).join(""), metadata: message.metadata };
});

describe("run lifecycle reports", () => {
  test("a repeated start of the run in progress applies nothing; a resumed run settles again, with or without a new start; a resent settlement applies nothing", async () => {
    const state = createAppState();
    const project = createProject("Lifecycle", "/tmp/lifecycle");
    createSession("session", project.id, { agentRuntimeType: "pi" });
    const runs = runsFor(state);
    runs.runStarted("session", "r1");
    const started = getSession("session")!.updated_at;
    // Pi reports `started` again for a run in progress (in-run compaction): already applied.
    runs.runStarted("session", "r1");
    expect(getSession("session")).toMatchObject({ activity_state: "running", updated_at: started });
    expect(runInProgress("session")).toBe("r1");
    const report = settled("session", "r1", "completed", { reportId: "report-1" });
    await runs.runSettled(report);
    await runs.runSettled(report);
    expect(latestSettlement("session")).toEqual({ seq: 1, nextSeq: 1, status: "completed" });

    // Pi resumes the settled run (after it was settled as interrupted): it runs and settles again.
    runs.runStarted("session", "r1");
    expect(getSession("session")?.activity_state).toBe("running");
    await runs.runSettled(settled("session", "r1"));
    // A resumed run may settle without reporting a new start.
    await runs.runSettled(settled("session", "r1", "failed", { error: { message: "failed on resume" } }));
    expect(latestSettlement("session")).toMatchObject({ seq: 3, status: "failed", error: { message: "failed on resume" } });
  });

  test("settlement persists the run's model metadata without rewriting canonical entries, and marks a top-level session finished", async () => {
    const project = createProject("Metadata", "/tmp/metadata");
    createSession("session", project.id, { agentRuntimeType: "pi" });
    persistCanonicalMessages("session", [reply("canonical")]);
    const original = getDb().query<{ message_json: string }, []>("SELECT message_json FROM session_messages").get()!.message_json;
    const runs = runsFor(createAppState());

    runs.runStarted("session", "run-1");
    await runs.runSettled(settled("session", "run-1", "completed", { metadata: { model: { provider: "faux", modelId: "model" }, thinkingLevel: "high" } }));

    expect(getDb().query<{ message_json: string }, []>("SELECT message_json FROM session_messages").get()!.message_json).toBe(original);
    expect(getSession("session")).toMatchObject({ activity_state: "finished", model_provider: "faux", model_id: "model", thinking_level: "high" });
  });

  test("a run in flight when its task closes settles without unread activity; a run resumed after the close settles unread", async () => {
    const project = createProject("Closing", "/tmp/closing-task");
    const task = createTask(project.id, "Closing task", null, "task/closing");
    createSession("session", project.id, { agentRuntimeType: "pi", taskId: task.id });
    const runs = runsFor(createAppState());

    runs.runStarted("session", "run-1");
    setTaskStatus(task.id, "closed");
    await runs.runSettled(settled("session", "run-1"));
    expect(getSession("session")?.activity_state).toBeNull();

    await Bun.sleep(2);
    runs.runStarted("session", "run-2");
    await runs.runSettled(settled("session", "run-2"));
    expect(getSession("session")?.activity_state).toBe("finished");
  });
});

describe("a child's report to its parent", () => {
  const repo = useTestRepo();
  const loopback = useLoopbackState();
  const model = useFakeModel();
  let runs: SessionRuns;
  let project: ReturnType<typeof createProject>;

  beforeEach(() => {
    project = createProject("Reports", repo.dir);
    createSession("parent", project.id, { agentRuntimeType: "pi", ...modelOf() });
    createSession("child", project.id, { agentRuntimeType: "pi", parentSessionId: "parent", ...modelOf() });
    runs = runsFor(loopback.state);
  });
  const modelOf = () => ({ modelProvider: model.model.provider, modelId: model.model.modelId });

  test("steers the parent first, under a key of the child and its settlement, then commits the settlement and clears the child's activity", async () => {
    // The child's settlements applied when its parent was steered.
    const submit = Sessions.prototype.submit;
    const settlementsAtSteer: number[] = [];
    const steers = spyOn(Sessions.prototype, "submit").mockImplementation(function (this: Sessions, ...args) {
      settlementsAtSteer.push(latestSettlement("child")?.seq ?? 0);
      return submit.apply(this, args);
    });
    try {
      runs.runStarted("child", "run-1");
      await runs.runSettled(settled("child", "run-1", "failed", { error: { code: "provider_error", message: "Provider unavailable" } }));
    } finally { steers.mockRestore(); }
    expect(settlementsAtSteer).toEqual([0]);
    expect(inputsOf("parent")).toEqual([{ reinsId: "child-report:child:1", text: "Session failed: Provider unavailable", metadata: { sourceSessionId: "child" } }]);
    expect(latestSettlement("child")).toMatchObject({ seq: 1, status: "failed" });
    expect(getSession("child")?.activity_state).toBeNull();

    // The parent's runtime runs the report: Pi frames it as coming from the child.
    const turn = await model.nextTurn("parent");
    expect(JSON.stringify(turn.context.messages)).toContain("Reins session update from session child");
    turn.finish();

    runs.runStarted("child", "run-2");
    persistCanonicalMessages("child", [reply("Second answer")]);
    const tipId = getDb().query<{ harness_id: string }, []>("SELECT harness_id FROM session_messages WHERE session_id = 'child' ORDER BY seq DESC LIMIT 1").get()!.harness_id;
    const report = settled("child", "run-2", "completed", { tipId });
    await runs.runSettled(report);
    // A resent settlement (its reply lost) applies nothing: the parent hears of it once.
    await runs.runSettled(report);
    expect(inputsOf("parent").map(input => input.reinsId)).toEqual(["child-report:child:1", "child-report:child:2"]);
    expect(inputsOf("parent")[1]?.text).toBe("Second answer");
  });

  test("a crash between the two steps: the steer was committed, the settlement was not; recovery settles the child and steers again under the same key, which Pi recognises as a replay", async () => {
    runs.runStarted("child", "run-1");
    // The first step of the child's settlement, before the process went away.
    await new Sessions(loopback.state, () => {}).submit("parent", { op: "steer", content: [{ type: "text", text: "Child result" }], clientId: "child-report:child:1", sourceSessionId: "child" });
    expect(getSession("child")?.activity_state).toBe("running");

    await runs.recoverInterruptedRuns();
    expect(latestSettlement("child")).toMatchObject({ seq: 1, status: "failed", error: { message: expect.stringContaining("interrupted") } });
    expect(getSession("child")?.activity_state).toBeNull();
    expect(inputsOf("parent")).toEqual([{ reinsId: "child-report:child:1", text: "Child result", metadata: { sourceSessionId: "child" } }]);
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

describe("recovery at process start", () => {
  const repo = useTestRepo();
  const loopback = useLoopbackState();
  const model = useFakeModel();

  let project: ReturnType<typeof createProject>;
  beforeEach(() => { project = createProject("Recovery", repo.dir); });

  /** Session `id` with a run its runtime left pending in storage, as a SIGTERM leaves it (suspended). */
  async function interrupted(id: string): Promise<void> {
    createSession(id, project.id, { agentRuntimeType: "pi", modelProvider: model.model.provider, modelId: model.model.modelId });
    await new Sessions(loopback.state, () => {}).submit(id, { op: "prompt", content: [{ type: "text", text: "Work" }], clientId: `${id}-work` });
    await model.nextTurn(id);
    const entry = loopback.state.process.sessions.live.get(id)!;
    loopback.state.process.sessions.live.delete(id);
    await entry.runtime.suspend();
  }

  test("resumes every running session with a pending operation in a new runtime; it stays running and completes", async () => {
    await interrupted("cut");
    expect(getSession("cut")?.activity_state).toBe("running");
    await runsFor(loopback.state).recoverInterruptedRuns();
    expect(getSession("cut")?.activity_state).toBe("running");
    expect(latestSettlement("cut")).toBeNull();
    (await model.nextTurn("cut")).finish({ reply: "Resumed" });
    await until(() => latestSettlement("cut")?.status === "completed", "the resumed run completed");
    expect(storedInput("cut", "cut-work")).not.toBeNull();
  });

  test("settles as interrupted a run with nothing pending, one whose resume fails, and one whose resume budget is spent; a session not running is left alone", async () => {
    const runs = runsFor(loopback.state);
    // Running on the row, but its run ended in Pi (the settlement never applied).
    createSession("ended", project.id, { agentRuntimeType: "pi", modelProvider: model.model.provider, modelId: model.model.modelId });
    runs.runStarted("ended", "ended-run");
    // Its runtime cannot open: its model is gone from the server's catalog.
    createSession("broken", project.id, { agentRuntimeType: "pi", modelProvider: model.model.provider, modelId: "missing" });
    runs.runStarted("broken", "broken-run");
    // Resumed too often already.
    await interrupted("crashing");
    for (let resume = 0; resume < AUTO_RESUME_LIMIT; resume++) expect(takeAutoResume("crashing")).toBe(true);
    createSession("idle", project.id, { agentRuntimeType: "pi" });

    await runs.recoverInterruptedRuns();
    for (const id of ["ended", "broken", "crashing"]) {
      expect(latestSettlement(id)).toMatchObject({ status: "failed", error: { message: "The run was interrupted: the server restarted" } });
      expect(getSession(id)?.activity_state).toBe("finished");
      // No longer in progress: Pi may resume it under its ID later, and that start applies.
      expect(runInProgress(id)).toBeNull();
    }
    expect(loopback.state.process.sessions.live.has("crashing")).toBe(false);
    expect(model.turns.filter(turn => turn.sessionId === "crashing")).toHaveLength(1);
    expect(getSession("idle")).toMatchObject({ activity_state: null });
    expect(latestSettlement("idle")).toBeNull();
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
const wait = (runs: SessionRuns, timeoutMs: number, inputs?: string[]) => runs.waitForSettlement("s", timeoutMs, inputs ? { inputs } : {});

describe("waitForSettlement", () => {
  function setup() {
    const project = createProject("Wait", "/tmp/wait-test");
    createSession("s", project.id, { agentRuntimeType: "pi" });
    return runsFor(createAppState());
  }

  test("resolves on the settlement of an input the caller submitted, bridging admission before the started report", async () => {
    const runs = setup();
    persistCanonicalMessages("s", [{ role: "user", content: [{ type: "text", text: "Work" }], clientId: "client-1", timestamp: 1 }]);
    expect(await wait(runs, 0, ["client-1"])).toEqual({ sessionId: "s", status: "timeout", result: null, error: null });
    let done = false;
    const waiting = wait(runs, 2000, ["client-1"]).finally(() => { done = true; });
    await Bun.sleep(30);
    // Admitted, but its run has not started: still waiting.
    expect(done).toBe(false);
    runs.runStarted("s", "run-1");
    await Bun.sleep(30);
    expect(done).toBe(false);
    persistCanonicalMessages("s", [reply("Result")]);
    await runs.runSettled(settled("s", "run-1"));
    expect(await waiting).toEqual({ sessionId: "s", status: "completed", result: "Result", error: null });
    // Already settled: resolves at once.
    expect(await wait(runs, 0, ["client-1"])).toEqual({ sessionId: "s", status: "completed", result: "Result", error: null });
  });

  test("returns failed and cancelled settlements, times out while running and rejects when aborted", async () => {
    const runs = setup();
    persistCanonicalMessages("s", [reply("partial")]);
    runs.runStarted("s", "run-1");
    expect(await wait(runs, 20)).toEqual({ sessionId: "s", status: "timeout", result: null, error: null });
    const controller = new AbortController();
    const aborted = runs.waitForSettlement("s", 2000, { signal: controller.signal });
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
    await runs.runSettled(settled("s", "run-1", "failed", { error: { message: "Provider failed" } }));
    expect(await wait(runs, 0)).toEqual({ sessionId: "s", status: "failed", result: null, error: "Provider failed" });
    runs.runStarted("s", "run-2");
    await runs.runSettled(settled("s", "run-2", "aborted", { error: { message: "Aborted" } }));
    expect(await wait(runs, 0)).toEqual({ sessionId: "s", status: "cancelled", result: null, error: "Aborted" });
  });

  test("a steer still queued in storage awaits its run; an input Pi never admitted expects none", async () => {
    const runs = setup();
    persistCanonicalMessages("s", []);
    runs.runStarted("s", "run-1");
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
    runs.runStarted("s", "run-2");
    persistCanonicalMessages("s", [reply("Steered")]);
    await runs.runSettled(settled("s", "run-2"));
    expect(await waiting).toEqual({ sessionId: "s", status: "completed", result: "Steered", error: null });
  });
});

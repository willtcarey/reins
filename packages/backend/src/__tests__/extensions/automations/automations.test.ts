import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { useTestDb } from "../../helpers/test-db.js";
import { createAppState, type TestAppState } from "../../helpers/app-state.js";
import { loopbackLink, stopLoopbackNode } from "../../helpers/loopback-node.js";
import { useFakeModel } from "../../helpers/fake-model.js";
import { until } from "../../helpers/session-host.js";
import { makeRequest } from "../../helpers/request.js";
import { scriptContext } from "../../helpers/script-context.js";
import { testAutomations, type TestAutomations } from "../../helpers/automations-extension.js";
import { runScript } from "../../../tools/execute.js";
import { searchScriptApi } from "../../../tools/search.js";
import { buildRouter } from "../../../routes/index.js";
import { Models } from "../../../models/models.js";
import { getDb } from "../../../app-globals.js";
import { deleteSession, getSession } from "../../../session-store.js";
import { COMPACTION_INSTRUCTIONS, wakeNote } from "../../../extensions/automations/automations.js";
import type { AutomationView, RunView } from "../../../extensions/automations/store.js";

/** The session's user inputs: their text and metadata, in order. */
const inputs = (sessionId: string) => getDb().query<{ text: string; metadata: string | null }, [string]>(`SELECT
    json_extract(message_json, '$.message.content[0].text') AS text, json_extract(message_json, '$.message.metadata') AS metadata
  FROM session_messages WHERE session_id = ? AND role = 'reinsInput' ORDER BY seq`).all(sessionId)
  .map(row => ({ text: row.text, metadata: row.metadata === null ? null : JSON.parse(row.metadata) }));

const backgroundSessions = () => getDb().query<{ id: string }, []>("SELECT id FROM sessions WHERE background = 1 ORDER BY created_at").all().map(row => row.id);

async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

describe("the automations extension", () => {
  useTestDb();
  const model = useFakeModel();
  let clock: TestAutomations;
  let state: TestAppState;
  let dir: string;

  const app = async () => {
    const created = createAppState(undefined, { loopbackNode: true, extensions: [clock.registration] });
    await loopbackLink(created).ready();
    await clock.idle();
    return created;
  };
  /** Runs `code` as an `execute` script of session `sessionId`; its result. */
  const script = async (sessionId: string, code: string) => {
    const result = await runScript(scriptContext(state, { sessionId }), code);
    if (!result.ok) throw new Error(result.error);
    return JSON.parse(result.text || "null");
  };
  const newSession = async () => (await new Models(state).sessions.create({ source: { nodeId: "internal", path: dir }, model: model.model })).id;
  const runs = (sessionId: string, id: number): Promise<RunView[]> => script(sessionId, `return await api.automations.runs(${id})`);

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "reins-automations-"));
    clock = testAutomations("2026-03-27T08:00:00.000Z");
    state = await app();
  });
  afterEach(async () => {
    await stopLoopbackNode(state);
    await state.nodes.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("search finds the functions by what an agent asks for", () => {
    expect(searchScriptApi("monitor until merged", state.extensions).text).toContain("wake(wakeUp: {");
    expect(searchScriptApi("every morning daily", state.extensions).text).toContain("heartbeat(heartbeat: {");
  });

  describe("wake-ups", () => {
    test("sends its message to the calling session each time it is due, from the automations extension", async () => {
      const sessionId = await newSession();

      const wake: AutomationView = await script(sessionId, `return await api.automations.wake({ schedule: "5m", message: "Check whether PR 42 merged" })`);
      clock.setNow("2026-03-27T08:04:00.000Z");
      await clock.tick();
      expect(model.turns).toEqual([]);
      clock.setNow("2026-03-27T08:05:10.000Z");
      await clock.tick();
      const turn = await model.nextTurn(sessionId);

      expect(wake).toMatchObject({ kind: "wake", sessionId, createdBySessionId: sessionId, message: "Check whether PR 42 merged", schedule: "5m", nextRunAt: "2026-03-27T08:05:00.000Z", cancelledAt: null });
      expect(turn.input).toBe(`Check whether PR 42 merged\n\n${wakeNote({ id: wake.id, schedule: "5m" })}`);
      expect(wakeNote({ id: wake.id, schedule: "5m" })).toContain(`api.automations.cancel(${wake.id})`);
      expect(inputs(sessionId)).toEqual([{ text: turn.input, metadata: { sourceExtension: "automations" } }]);
      expect(await runs(sessionId, wake.id)).toEqual([{
        id: expect.any(Number), automationId: wake.id, sessionId, outcome: "sent", startedAt: "2026-03-27T08:05:10.000Z", endedAt: "2026-03-27T08:05:10.000Z",
        output: null, error: null, compaction: null, compactionError: null,
      }]);
      expect((await script(sessionId, "return await api.automations.list()"))[0].nextRunAt).toBe("2026-03-27T08:10:10.000Z");
    });

    test("skips a wake-up that is due while its session is busy", async () => {
      const sessionId = await newSession();
      const wake: AutomationView = await script(sessionId, `return await api.automations.wake({ schedule: "5m", message: "Look again" })`);
      clock.setNow("2026-03-27T08:05:00.000Z");
      await clock.tick();
      const busy = await model.nextTurn(sessionId);

      clock.setNow("2026-03-27T08:10:00.000Z");
      await clock.tick();
      busy.finish();

      expect((await runs(sessionId, wake.id)).map(run => [run.outcome, run.startedAt])).toEqual([
        ["skipped", "2026-03-27T08:10:00.000Z"],
        ["sent", "2026-03-27T08:05:00.000Z"],
      ]);
      expect(inputs(sessionId)).toHaveLength(1);
    });

    test("is cancelled by the agent, and by archiving or deleting its session, and is then never sent", async () => {
      const [byAgent, archived, deleted] = [await newSession(), await newSession(), await newSession()];
      const wakeOf = async (sessionId: string): Promise<AutomationView> => script(sessionId, `return await api.automations.wake({ schedule: "5m", message: "Ping" })`);
      const agentWake = await wakeOf(byAgent);
      await wakeOf(archived);
      await wakeOf(deleted);

      const cancelled: AutomationView = await script(byAgent, `return await api.automations.cancel(${agentWake.id})`);
      new Models(state).sessions.updateMetadata(archived, { archived: true });
      deleteSession(deleted);
      clock.setNow("2026-03-27T08:05:00.000Z");
      await clock.tick();
      clock.setNow("2026-03-27T08:10:00.000Z");
      await clock.tick();

      expect(cancelled).toMatchObject({ cancelledAt: "2026-03-27T08:00:00.000Z", cancelReason: `Cancelled by session ${byAgent}`, nextRunAt: null });
      expect(await script(byAgent, "return await api.automations.list({ all: true })")).toEqual([]);
      expect((await script(byAgent, "return await api.automations.list({ all: true, includeCancelled: true })")).map((view: AutomationView) => [view.sessionId, view.cancelledAt, view.cancelReason])).toEqual([
        [deleted, "2026-03-27T08:05:00.000Z", "Its session was deleted"],
        [archived, "2026-03-27T08:05:00.000Z", "Its session was archived"],
        [byAgent, "2026-03-27T08:00:00.000Z", `Cancelled by session ${byAgent}`],
      ]);
      expect(model.turns).toEqual([]);
    });

    test("the user lists a session's wake-ups and cancels one over HTTP", async () => {
      const sessionId = await newSession();
      const wake: AutomationView = await script(sessionId, `return await api.automations.wake({ schedule: "daily 09:00", timezone: "Europe/London", message: "Morning check" })`);
      const call = (method: string, body: object) => buildRouter().handle(makeRequest("POST", `/api/extensions/automations/${method}`, body), state);

      const listed = await (await call("list", { sessionId }))!.json();
      const cancelled = await call("cancel", { id: wake.id });
      const unknown = await call("cancel", { id: 999 });

      expect(listed).toEqual([expect.objectContaining({ id: wake.id, nextRunAt: "2026-03-27T09:00:00.000Z" })]);
      expect(cancelled!.status).toBe(200);
      expect(await cancelled!.json()).toMatchObject({ id: wake.id, cancelReason: "Cancelled by the user", nextRunAt: null });
      expect(unknown!.status).toBe(404);
      expect(await unknown!.json()).toEqual({ error: "Automation not found: 999" });
    });
  });

  describe("heartbeats", () => {
    const heartbeatCode = (options = "") => `return await api.automations.heartbeat({ name: "GitHub notifications", schedule: "daily 09:00", timezone: "Europe/London",
      prompt: "List my new GitHub notifications", model: ${JSON.stringify(model.model)}${options} })`;

    test("runs its prompt on one hidden session of no project, kept across runs, and records each run's output or failure", async () => {
      const caller = await newSession();

      const heartbeat: AutomationView = await script(caller, heartbeatCode());
      const hidden = heartbeat.sessionId!;
      (await model.nextTurn(hidden)).finish({ reply: "3 new notifications" });
      await eventually(() => runs(caller, heartbeat.id), list => list[0]?.outcome === "completed", "the first run recorded");
      clock.setNow("2026-03-27T09:00:00.000Z");
      await clock.tick();
      const second = await model.nextTurn(hidden);
      second.finish({ status: "failed", error: "Provider down" });
      const recorded = await eventually(() => runs(caller, heartbeat.id), list => list[0]?.outcome === "failed", "the second run recorded");

      expect(heartbeat).toMatchObject({ kind: "heartbeat", name: "GitHub notifications", createdBySessionId: caller, source: getSession(caller)!.source_id, nextRunAt: "2026-03-27T09:00:00.000Z" });
      expect(getSession(hidden)).toMatchObject({ background: 1, project_id: null, source_id: getSession(caller)!.source_id, source_extension: "automations", name: "GitHub notifications" });
      expect(second.input).toBe("List my new GitHub notifications");
      expect(inputs(hidden).map(input => input.text)).toEqual(["List my new GitHub notifications", "List my new GitHub notifications"]);
      expect(backgroundSessions()).toEqual([hidden]);
      expect(recorded.map(run => [run.sessionId, run.outcome, run.startedAt, run.output, run.error])).toEqual([
        [hidden, "failed", "2026-03-27T09:00:00.000Z", null, "Provider down"],
        [hidden, "completed", "2026-03-27T08:00:00.000Z", "3 new notifications", null],
      ]);
      const [view] = await script(caller, "return await api.automations.list()");
      expect(view).toMatchObject({ sessionId: hidden, consecutiveFailures: 1, lastRun: { outcome: "failed" }, nextRunAt: "2026-03-28T09:00:00.000Z" });
    });

    test("runs once at startup after the runs it missed while Reins was down", async () => {
      const caller = await newSession();
      const heartbeat: AutomationView = await script(caller, heartbeatCode());
      (await model.nextTurn(heartbeat.sessionId!)).finish({ reply: "Nothing new" });
      await eventually(() => runs(caller, heartbeat.id), list => list[0]?.outcome === "completed", "the first run recorded");

      // Down from Friday to Monday morning (London is on BST from Sunday), then a new server process starts.
      await state.extensions.dispose();
      await stopLoopbackNode(state);
      clock.setNow("2026-03-30T10:00:00.000Z");
      state = await app();
      const turn = await model.nextTurn(heartbeat.sessionId!);
      turn.finish({ reply: "Three days of notifications" });
      const recorded = await eventually(() => runs(caller, heartbeat.id), list => list[0]?.outcome === "completed" && list.length === 2, "the missed run recorded");

      expect(recorded.map(run => [run.startedAt, run.output])).toEqual([
        ["2026-03-30T10:00:00.000Z", "Three days of notifications"],
        ["2026-03-27T08:00:00.000Z", "Nothing new"],
      ]);
      expect(model.turns.filter(candidate => candidate.sessionId === heartbeat.sessionId)).toHaveLength(2);
      expect((await script(caller, "return await api.automations.list()"))[0].nextRunAt).toBe("2026-03-31T08:00:00.000Z");
    });

    test("compacts its session after a run that leaves the context above its threshold", async () => {
      const caller = await newSession();
      const heartbeat: AutomationView = await script(caller, heartbeatCode(", compactAboveTokens: 1"));
      (await model.nextTurn(heartbeat.sessionId!)).finish({ reply: "2 new notifications" });
      await eventually(() => runs(caller, heartbeat.id), list => list[0]?.compaction === "pending", "the run's compaction pending");

      clock.setNow("2026-03-27T08:01:00.000Z");
      await clock.tick();
      const summary = await model.nextSummary();
      summary.finish({ reply: "Reported so far: 2 notifications" });

      expect(JSON.stringify(summary.context)).toContain(COMPACTION_INSTRUCTIONS);
      expect((await runs(caller, heartbeat.id))[0]).toMatchObject({ outcome: "completed", compaction: "started" });
      await until(() => getDb().query<{ role: string }, [string]>("SELECT role FROM session_messages WHERE session_id = ? ORDER BY seq DESC LIMIT 1").get(heartbeat.sessionId!)?.role === "compaction", "the compaction committed");
    });

    test("replacing its session starts its next run on a new hidden session", async () => {
      const caller = await newSession();
      const heartbeat: AutomationView = await script(caller, heartbeatCode());
      (await model.nextTurn(heartbeat.sessionId!)).finish();
      await eventually(() => runs(caller, heartbeat.id), list => list[0]?.outcome === "completed", "the first run recorded");

      const replaced: AutomationView = await script(caller, `return await api.automations.replaceSession(${heartbeat.id})`);
      clock.setNow("2026-03-27T09:00:00.000Z");
      await clock.tick();
      const [view] = await script(caller, "return await api.automations.list()");
      const turn = await model.nextTurn(view.sessionId);

      expect(replaced.sessionId).toBeNull();
      expect(view.sessionId).not.toBe(heartbeat.sessionId);
      expect(backgroundSessions()).toEqual([heartbeat.sessionId!, view.sessionId]);
      expect(turn.input).toBe("List my new GitHub notifications");
    });
  });
});

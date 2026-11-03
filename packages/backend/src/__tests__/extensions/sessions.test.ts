import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ServerSdk, SessionSettlement } from "@reins/sdk/server";
import { useTestDb } from "../helpers/test-db.js";
import { createAppState, type TestAppState } from "../helpers/app-state.js";
import { loopbackLink, stopLoopbackNode } from "../helpers/loopback-node.js";
import { useFakeModel } from "../helpers/fake-model.js";
import { until } from "../helpers/session-host.js";
import { makeRequest } from "../helpers/request.js";
import { createProject } from "../project-fixture.js";
import { createTask } from "../../task-store.js";
import { getDb } from "../../app-globals.js";
import { upsertSource } from "../../node-store.js";
import { buildRouter } from "../../routes/index.js";
import type { ExtensionView } from "../../extensions/host.js";

/** What the session's user inputs carry: their text and metadata, in order. */
const inputs = (sessionId: string) => getDb().query<{ text: string; metadata: string | null }, [string]>(`SELECT
    json_extract(message_json, '$.message.content[0].text') AS text, json_extract(message_json, '$.message.metadata') AS metadata
  FROM session_messages WHERE session_id = ? AND role = 'reinsInput' ORDER BY seq`).all(sessionId)
  .map(row => ({ text: row.text, metadata: row.metadata === null ? null : JSON.parse(row.metadata) }));

const storedRoles = (sessionId: string) => getDb()
  .query<{ role: string }, [string]>("SELECT role FROM session_messages WHERE session_id = ? ORDER BY seq").all(sessionId).map(row => row.role);

const sessionCount = () => getDb().query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sessions").get()!.n;

describe("reins.sessions", () => {
  useTestDb();
  const model = useFakeModel();
  let state: TestAppState;
  let automation: ServerSdk;
  let other: ServerSdk;
  let dir: string;
  const settled: Record<string, SessionSettlement[]> = {};

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "reins-heartbeat-"));
    for (const name of ["automation", "other"]) settled[name] = [];
    state = createAppState(undefined, {
      loopbackNode: true,
      extensions: [
        { name: "automation", register: reins => { automation = reins; return reins.sessions.onSettled(settlement => { settled.automation!.push(settlement); }); } },
        { name: "other", register: reins => { other = reins; return reins.sessions.onSettled(settlement => { settled.other!.push(settlement); }); } },
      ],
    });
    await loopbackLink(state).ready();
  });
  afterEach(async () => {
    await stopLoopbackNode(state);
    await state.nodes.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("starts a background session on a location of no project, its prompt from the extension, and tells it the run's outcome and final reply", async () => {
    const sessionId = await automation.sessions.start({ source: { nodeId: "internal", path: dir }, prompt: "Morning heartbeat", background: true, model: model.model });

    expect(await automation.sessions.get(sessionId)).toMatchObject({
      id: sessionId, source: { nodeId: "internal", path: dir }, projectId: null, taskId: null, background: true, running: true, startedBy: "automation", archivedAt: null,
    });
    const turn = await model.nextTurn(sessionId);
    expect(turn.input).toBe("Morning heartbeat");
    turn.finish({ reply: "All quiet" });
    await until(() => settled.automation!.length > 0, "the run settled");

    expect(settled).toEqual({ automation: [{ sessionId, status: "completed", result: "All quiet", error: null }], other: [] });
    expect(await automation.sessions.get(sessionId)).toMatchObject({ running: false });
    expect(inputs(sessionId)).toEqual([{ text: "Morning heartbeat", metadata: { sourceExtension: "automation" } }]);
  });

  test("sends to an existing session as a steer from the extension, idle or running, and a failed run is told as failed", async () => {
    const project = createProject("Project", dir);
    const sessionId = await automation.sessions.start({ projectId: project.id, prompt: "Watch the build", model: model.model });
    expect(await automation.sessions.get(sessionId)).toMatchObject({ projectId: project.id, source: { path: dir }, background: false });

    // Running: the message joins the run in progress.
    await other.sessions.send(sessionId, "Also check the logs");
    (await model.nextTurn(sessionId)).finish({ reply: "Watching" });
    await until(() => settled.automation!.length === 1, "the first run settled");
    // Idle: the message starts a run.
    await automation.sessions.send(sessionId, "Wake up");
    (await model.nextTurn(sessionId)).finish({ status: "failed", error: "Provider down" });
    await until(() => settled.automation!.length === 2, "the second run settled");

    expect(inputs(sessionId)).toEqual([
      { text: "Watch the build", metadata: { sourceExtension: "automation" } },
      { text: "Also check the logs", metadata: { sourceExtension: "other" } },
      { text: "Wake up", metadata: { sourceExtension: "automation" } },
    ]);
    expect(settled.automation).toEqual([
      { sessionId, status: "completed", result: "Watching", error: null },
      { sessionId, status: "failed", result: null, error: "Provider down" },
    ]);
    // Only the extension that started a session hears of its runs.
    expect(settled.other).toEqual([]);
  });

  test("refuses a start with neither a source nor a project, or anything it names that is not there, keeping nothing; a session whose first prompt is refused is kept", async () => {
    const project = createProject("Project", dir);
    const otherProject = createProject("Other", dir);
    const task = createTask(otherProject.id, "Elsewhere", null, "task/elsewhere");
    const refusal = (start: Parameters<ServerSdk["sessions"]["start"]>[0]) => automation.sessions.start(start).then(() => "started", (error: Error) => error.message);

    expect(await refusal({ prompt: "Hello" })).toBe("A session of no project needs a source");
    expect(await refusal({ projectId: 999, prompt: "Hello" })).toBe("Project not found: 999");
    expect(await refusal({ projectId: project.id, taskId: task.id, prompt: "Hello" })).toBe(`Task ${task.id} is not a task of project ${project.id}`);
    expect(await refusal({ source: 999, prompt: "Hello" })).toBe("Source not found: 999");
    expect(await refusal({ projectId: project.id, prompt: "Hello", title: " " })).toBe("A session's title must not be blank");
    expect(await refusal({ source: { nodeId: "nowhere", path: dir }, prompt: "Hello" })).toBe("Node not found: nowhere");
    expect(await refusal({ source: { nodeId: "internal", path: join(dir, "missing") }, prompt: "Hello" })).toBe(`Directory does not exist: ${join(dir, "missing")}`);
    expect(await refusal({ projectId: project.id, prompt: "Hello", model: { provider: model.model.provider, modelId: "missing" } })).toBe(`Model 'missing' not found for provider '${model.model.provider}'`);
    expect(await refusal({ projectId: project.id, prompt: "  " })).toBe("A session's prompt must not be blank");
    expect(sessionCount()).toBe(0);
    // A known location on a removed node: the session is made and its prompt refused; it stays, to be moved.
    getDb().exec("INSERT INTO nodes (id, name, removed_at) VALUES ('gone', 'Gone', '2026-10-11T09:00:00.000Z')");
    const stranded = upsertSource("gone", "/gone/notes");
    expect(await refusal({ source: stranded.id, prompt: "Hello", model: model.model })).toBe("This session's node was removed; move it to another node to continue");
    expect(sessionCount()).toBe(1);
  });

  test("reads how full a session's context is, and compacts it with the given instructions", async () => {
    const sessionId = await automation.sessions.start({ source: { nodeId: "internal", path: dir }, prompt: "Check the inbox", background: true, model: model.model });
    (await model.nextTurn(sessionId)).finish({ reply: "Two new mails" });
    await until(() => settled.automation!.length > 0, "the run settled");

    const usage = await automation.sessions.contextUsage(sessionId);
    expect(usage).toEqual({ usedTokens: expect.any(Number), contextWindow: 200_000, measurement: "exact" });
    expect(usage!.usedTokens).toBeGreaterThan(0);
    await automation.sessions.compact(sessionId, { instructions: "Keep the senders" });
    expect(await automation.sessions.get(sessionId)).toMatchObject({ running: true });
    const summary = await model.nextSummary();
    expect(JSON.stringify(summary.context)).toContain("Keep the senders");
    summary.finish({ reply: "Mail from Ana and Bo" });
    await until(() => storedRoles(sessionId).at(-1) === "compaction", "the compaction was committed");
    expect(await automation.sessions.contextUsage(sessionId)).toMatchObject({ measurement: "estimated" });
  });

  test("refuses a session the server does not have", async () => {
    await expect(automation.sessions.get("missing")).rejects.toThrow("Session not found: missing");
    await expect(automation.sessions.send("missing", "Hello")).rejects.toThrow("Session not found: missing");
    await expect(automation.sessions.compact("missing")).rejects.toThrow("Session not found: missing");
    await expect(automation.sessions.contextUsage("missing")).rejects.toThrow("Session not found: missing");
  });

  test("the host's report counts each extension's settlement listeners, gone once disposed", async () => {
    const dispose = automation.sessions.onSettled(() => {});
    const report = async () => {
      const views: ExtensionView[] = await (await buildRouter().handle(makeRequest("GET", "/api/extensions"), state))!.json();
      return views.map(view => [view.name, view.registrations.settlementListeners]);
    };

    expect(await report()).toEqual([["automation", 2], ["other", 1]]);
    await dispose();
    expect(await report()).toEqual([["automation", 1], ["other", 1]]);
  });
});

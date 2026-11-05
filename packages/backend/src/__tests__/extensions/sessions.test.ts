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
import { createSession, updateActivityState } from "../session-fixture.js";
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

/** The session's user inputs as stored: their content blocks and metadata, in order. */
const storedInputs = (sessionId: string) => getDb().query<{ message: string }, [string]>(
  "SELECT json_extract(message_json, '$.message') AS message FROM session_messages WHERE session_id = ? AND role = 'reinsInput' ORDER BY seq",
).all(sessionId).map(row => { const { content, metadata } = JSON.parse(row.message); return { content, metadata }; });

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
    const { sessionId } = await automation.sessions.start("Morning heartbeat", { source: { nodeId: "internal", path: dir }, background: true, model: model.model });

    expect(await automation.sessions.get(sessionId)).toMatchObject({
      id: sessionId, source: { nodeId: "internal", path: dir }, projectId: null, taskId: null, background: true, running: true, startedBy: "automation", archived: false, lastRunId: null,
    });
    const startedWhileRunning = (await automation.sessions.get(sessionId)).lastRunStartedAt;
    expect(startedWhileRunning).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const turn = await model.nextTurn(sessionId);
    expect(turn.input).toBe("Morning heartbeat");
    turn.finish({ reply: "All quiet" });
    await until(() => settled.automation!.length > 0, "the run settled");

    expect(settled).toEqual({ automation: [{ sessionId, status: "completed", result: "All quiet", error: null }], other: [] });
    expect(await automation.sessions.get(sessionId)).toMatchObject({ running: false, lastRunStartedAt: startedWhileRunning });
    expect(inputs(sessionId)).toEqual([{ text: "Morning heartbeat", metadata: { sourceExtension: "automation" } }]);
  });

  test("sends to an existing session as a steer from the extension, idle or running, and a failed run is told as failed", async () => {
    const project = createProject("Project", dir);
    const { sessionId } = await automation.sessions.start("Watch the build", { projectId: project.id, model: model.model });
    expect(await automation.sessions.get(sessionId)).toMatchObject({ projectId: project.id, source: { path: dir }, background: false });

    // Running: the message joins the run in progress.
    await other.sessions.send(sessionId, "Also check the logs");
    (await model.nextTurn(sessionId)).finish({ reply: "Watching" });
    await until(() => settled.automation!.length === 1, "the first run settled");
    const firstRunId = (await automation.sessions.get(sessionId)).lastRunId;
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
    const secondRunId = (await automation.sessions.get(sessionId)).lastRunId;
    expect(firstRunId).toEqual(expect.any(String));
    expect(secondRunId).toEqual(expect.any(String));
    expect(secondRunId).not.toBe(firstRunId);
    // Only the extension that started a session hears of its runs.
    expect(settled.other).toEqual([]);
  });

  test("refuses a start with neither a source nor a project, or anything it names that is not there, keeping nothing; a session whose first prompt is refused is kept", async () => {
    const project = createProject("Project", dir);
    const otherProject = createProject("Other", dir);
    const task = createTask(otherProject.id, "Elsewhere", null, "task/elsewhere");
    const refusal = ({ prompt, ...options }: { prompt: string } & NonNullable<Parameters<ServerSdk["sessions"]["start"]>[1]>) =>
      automation.sessions.start(prompt, options).then(() => "started", (error: Error) => error.message);

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
    const { sessionId } = await automation.sessions.start("Check the inbox", { source: { nodeId: "internal", path: dir }, background: true, model: model.model });
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

  test("a message's hidden blocks reach the model after its text and the chat collapses them; its metadata is only kept", async () => {
    const { sessionId } = await automation.sessions.start(["The deploy finished", { text: "step 1 ok", hidden: true, label: "Deploy log" }, { text: "step 2 ok", hidden: true }], {
      source: { nodeId: "internal", path: dir }, background: true, model: model.model, metadata: { deployId: 18 },
    });
    const first = await model.nextTurn(sessionId);
    first.finish();
    await until(() => settled.automation!.length === 1, "the first run settled");
    await automation.sessions.send(sessionId, ["Check it again", { text: "No label", hidden: true }]);
    const second = await model.nextTurn(sessionId);

    // The label is the chat's, and the metadata only kept: the model gets the blocks, the hidden ones a blank line apart.
    expect(first.input).toBe("The deploy finished\n\n\nstep 1 ok\nstep 2 ok");
    expect(second.input).toBe("Check it again\n\n\nNo label");
    expect(storedInputs(sessionId)).toEqual([
      {
        content: [{ type: "text", text: "The deploy finished" }, { type: "text", text: "step 1 ok" }, { type: "text", text: "step 2 ok" }],
        metadata: { deployId: 18, sourceExtension: "automation", details: { label: "Deploy log", start: 1 } },
      },
      { content: [{ type: "text", text: "Check it again" }, { type: "text", text: "No label" }], metadata: { sourceExtension: "automation", details: { label: null, start: 1 } } },
    ]);
    second.finish();
  });

  test("refuses blocks out of order, blank or without a visible one, and metadata that is not plain JSON or has Reins' keys", async () => {
    const { sessionId } = await automation.sessions.start("Hello", { source: { nodeId: "internal", path: dir }, background: true, model: model.model });
    (await model.nextTurn(sessionId)).finish();
    // As an extension without TypeScript could give them.
    const refusal = (message: unknown, metadata?: unknown) => Reflect.apply(automation.sessions.send, automation.sessions, [sessionId, message, { metadata }])
      .then(() => "sent", (error: Error) => error.message);

    expect(await refusal([{ text: "Log", hidden: true }, "Hello"])).toBe("A message's hidden blocks come after its visible ones");
    expect(await refusal([{ text: "Log", hidden: true }])).toBe("A message must not be blank");
    expect(await refusal(["Hello", { text: " ", hidden: true }])).toBe("A message's blocks must not be blank");
    expect(await refusal(["Hello", { text: "a", hidden: true }, { text: "b", hidden: true, label: "B" }])).toBe("Only a message's first hidden block has a label");
    expect(await refusal(["Hello", { text: "Log", label: "Log" }])).toBe("Only a message's first hidden block has a label");
    expect(await refusal("Hello", { sourceExtension: "mcp" })).toBe("Metadata key sourceExtension is set by Reins");
    expect(await refusal("Hello", { details: { start: 0 } })).toBe("Metadata key details is set by Reins");
    expect(await refusal("Hello", { when: new Date(0) })).toBe("Metadata must be plain JSON: a Date at when");
    expect(await refusal("Hello", [1])).toBe("Metadata must be a plain object");
    expect(await refusal("Hello", { big: "x".repeat(70_000) })).toBe("Metadata must be at most 65536 bytes of JSON");
    expect(storedInputs(sessionId)).toHaveLength(1);
  });

  test("lists the sessions the browser lists, of every project, the latest change first, a page at a time, with their first message and unread", async () => {
    const project = createProject("Project", dir);
    for (const id of ["older", "newer", "archived", "hidden"]) createSession(id, project.id, { agentRuntimeType: "pi" });
    const setUpdated = (id: string, at: string) => getDb().query("UPDATE sessions SET updated_at = ? WHERE id = ?").run(at, id);
    setUpdated("older", "2026-01-01T00:00:00.000Z");
    setUpdated("newer", "2026-01-02T00:00:00.000Z");
    getDb().query("UPDATE sessions SET archived_at = '2026-01-03T00:00:00.000Z' WHERE id = 'archived'").run();
    getDb().query("UPDATE sessions SET background = 1 WHERE id = 'hidden'").run();
    updateActivityState("older", "finished");
    getDb().query(`INSERT INTO session_messages (session_id, seq, role, message_json) VALUES ('newer', 1, 'reinsInput', ?)`)
      .run(JSON.stringify({ message: { role: "reinsInput", content: [{ type: "text", text: "Fix the build" }] } }));

    const pages = [await automation.sessions.list({ limit: 1 }), await automation.sessions.list({ limit: 1, offset: 1 }), await automation.sessions.list({ offset: 2 })];

    expect(pages.map(page => page.map(({ id, firstMessage, unread }) => ({ id, firstMessage, unread })))).toEqual([
      [{ id: "newer", firstMessage: "Fix the build", unread: false }],
      [{ id: "older", firstMessage: null, unread: true }],
      [],
    ]);
    await expect(automation.sessions.list({ limit: 0 })).rejects.toThrow("limit must be an integer from 1 to 200");
  });

  test("reads projects and tasks, and refuses ones the server does not have", async () => {
    const project = createProject("Project", dir);
    const task = createTask(project.id, "Ship it", null, "task/ship-it");
    getDb().query("UPDATE tasks SET closed_at = '2026-01-03T00:00:00.000Z' WHERE id = ?").run(task.id);

    expect(await automation.projects.get(project.id)).toMatchObject({ id: project.id, name: "Project", defaultSourceId: project.default_source_id });
    expect(await automation.tasks.get(task.id)).toMatchObject({ id: task.id, projectId: project.id, title: "Ship it", closedAt: "2026-01-03T00:00:00.000Z" });
    await expect(automation.projects.get(999)).rejects.toThrow("Project not found: 999");
    await expect(automation.tasks.get(999)).rejects.toThrow("Task not found: 999");
  });

  test("waits for a session and lists a project's sessions, as scripts do; \"current\" is refused, as an extension has no session", async () => {
    const project = createProject("Project", dir);
    const { sessionId } = await automation.sessions.start("Build it", { projectId: project.id, model: model.model });
    const waiting = automation.sessions.wait(sessionId, 10_000);
    (await model.nextTurn(sessionId)).finish({ reply: "Built" });

    expect(await waiting).toEqual({ sessionId, status: "completed", result: "Built", error: null });
    expect((await automation.sessions.list({ projectId: project.id })).map(session => session.id)).toEqual([sessionId]);
    await expect(automation.sessions.current()).rejects.toThrow("sessions.current names the calling session, and an extension has none");
    await expect(automation.sessions.start("Child", { projectId: project.id, parentSessionId: "current" })).rejects.toThrow("options.parentSessionId \"current\" names the calling session, and an extension has none");
    await expect(automation.tasks.list()).rejects.toThrow("An extension names the project: it has no calling session");
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

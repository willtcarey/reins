import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ServerSdk, SessionKind, SessionKindContext, SystemPromptContext } from "@reins/sdk/server";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { useTestDb } from "../helpers/test-db.js";
import { useTestRepo } from "../helpers/test-repo.js";
import { createAppState, type TestAppState } from "../helpers/app-state.js";
import { loopbackLink, stopLoopbackNode } from "../helpers/loopback-node.js";
import { useFakeModel, type FakeTurn } from "../helpers/fake-model.js";
import { makeRequest } from "../helpers/request.js";
import { scriptContext } from "../helpers/script-context.js";
import { createProject } from "../project-fixture.js";
import { createTask } from "../../task-store.js";
import { getSession } from "../../session-store.js";
import { createSession } from "../session-fixture.js";
import { getSource } from "../../node-store.js";
import { SessionModel } from "../../models/session.js";
import { buildRouter } from "../../routes/index.js";
import { buildApiObject } from "../../sdk-host/scripts.js";
import { SessionHandleSchema } from "../../sdk-host/sessions.js";
import { Value } from "@sinclair/typebox/value";
import { reinsSystemPrompt } from "../../sessions/system-prompt.js";
import type { ExtensionView } from "../../extension-system/report.js";

const promptOf = (turn: FakeTurn) => getCurrentSystemPrompt(turn.context.messages) ?? turn.context.systemPrompt;
const toolsOf = (turn: FakeTurn) => (getCurrentTools(turn.context.messages) ?? turn.context.tools ?? []).map(tool => tool.name);

describe("session kinds of extensions", () => {
  useTestDb();
  const repo = useTestRepo();
  const model = useFakeModel();
  let state: TestAppState;
  let coord: ServerSdk;
  let other: ServerSdk;
  /** What each extension registers as its `coordinator` kind; a test changes it before the app starts. */
  let kinds: Record<"coord" | "other", SessionKind>;
  let seen: { kind: SessionKindContext[]; sections: SystemPromptContext[] };

  const start = async () => {
    state = createAppState(undefined, {
      loopbackNode: true,
      extensions: [
        {
          name: "coord",
          register: reins => {
            coord = reins;
            const section = reins.sessions.registerSystemPromptSection(context => { seen.sections.push(context); return "Coord's section"; });
            const kind = reins.sessions.registerKind("coordinator", kinds.coord);
            return async () => { await section(); await kind(); };
          },
        },
        {
          name: "other",
          register: reins => {
            other = reins;
            const section = reins.sessions.registerSystemPromptSection(() => "Other's section");
            const kind = reins.sessions.registerKind("coordinator", kinds.other);
            return async () => { await section(); await kind(); };
          },
        },
      ],
    });
    await loopbackLink(state).ready();
  };

  beforeEach(() => {
    seen = { kind: [], sections: [] };
    kinds = {
      coord: { systemPrompt: context => { seen.kind.push(context); return "You coordinate."; }, tools: ["execute", "search"], environment: false },
      other: { systemPrompt: () => "You are the other coordinator.", tools: ["read"], environment: false },
    };
  });
  afterEach(async () => {
    await stopLoopbackNode(state);
    await state.nodes.close();
  });

  test("a session of a kind runs with the kind's prompt, every extension's sections after it, and the kind's tools", async () => {
    await start();
    const project = createProject("Project", repo.dir);
    const { sessionId } = await coord.sessions.start("Plan the week", { projectId: project.id, model: model.model, kind: "coordinator" });

    const turn = await model.nextTurn(sessionId);
    expect(promptOf(turn)).toBe("You coordinate.\n\nCoord's section\n\nOther's section");
    expect(toolsOf(turn)).toEqual(["execute", "search"]);
    turn.finish();

    expect(seen.kind).toHaveLength(1);
    expect(seen.kind[0]).toMatchObject({ session: { id: sessionId, projectId: project.id, taskId: null, kind: "coord/coordinator" }, task: null });
    // Sections are asked for the kind's tools, and told the session's kind.
    expect(seen.sections).toEqual([{ session: { id: sessionId, projectId: project.id, taskId: null, kind: "coord/coordinator" }, task: null, tools: ["execute", "search"] }]);
    expect(await coord.sessions.get(sessionId)).toMatchObject({ kind: "coord/coordinator", startedBy: "coord" });
  });

  test("the kind's context gives Reins' base prompt for the session's task, project and the kind's tools; the environment follows when the kind asks", async () => {
    kinds.coord = {
      systemPrompt: context => `${context.reinsSystemPrompt()}\n\nAlso coordinate.`,
      tools: ["read", "bash"],
    };
    await start();
    const project = createProject("Project", repo.dir);
    const task = createTask(project.id, "Ship it", "Release the thing", "task/ship-it");
    const { sessionId } = await coord.sessions.start("Go", { projectId: project.id, taskId: task.id, model: model.model, kind: "coordinator" });

    const turn = await model.nextTurn(sessionId);
    const base = reinsSystemPrompt({ task: { title: "Ship it", description: "Release the thing" }, tools: ["read", "bash"] });
    expect(base).not.toContain("Session orchestration");
    expect(promptOf(turn)).toStartWith(`${base}\n\nAlso coordinate.\n\nCoord's section\n\nOther's section\n\nCurrent working directory: ${repo.dir}`);
    expect(promptOf(turn)).toContain("Available tools:\n- read:");
    expect(toolsOf(turn)).toEqual(["read", "bash"]);
    turn.finish();
  });

  test("an agent session's model is offered Reins' tools alone: none of Pi's built-in extensions (codemode, tool_search, MCP) reach it", async () => {
    await start();
    const project = createProject("Project", repo.dir);
    const { sessionId } = await coord.sessions.start("Go", { projectId: project.id, model: model.model });

    const turn = await model.nextTurn(sessionId);
    expect(toolsOf(turn)).toEqual(["read", "write", "edit", "bash", "create_task", "search", "execute"]);
    expect(promptOf(turn)).not.toContain("mcp_servers");
    turn.finish();
  });

  test("a kind's task session checks out its task's branch when it is offered tools; one with no tools changes nothing on open", async () => {
    kinds.other = { systemPrompt: () => "Summarize.", tools: [], environment: false };
    await start();
    const project = createProject("Project", repo.dir);
    const task = createTask(project.id, "Ship it", null, "task/ship-it");
    const contextOf = async (sessionId: string) => {
      const row = getSession(sessionId)!;
      return new SessionModel(row, state.nodes).context(getSource(row.source_id)!, state.process.app);
    };
    const created = (extension: ServerSdk) => extension.sessions.start("Go", { projectId: project.id, taskId: task.id, model: model.model, kind: "coordinator" });

    const coordinated = await created(coord);
    const summarized = await created(other);

    expect((await contextOf(coordinated.sessionId)).branch).toMatchObject({ name: "task/ship-it" });
    expect((await contextOf(summarized.sessionId)).branch).toBeNull();
    for (const { sessionId } of [coordinated, summarized]) (await model.nextTurn(sessionId)).finish();
  });

  test("the kind's model is the session's when start gives none; a model start gives wins; a model the server does not have is refused", async () => {
    kinds.coord = { ...kinds.coord, model: { ...model.model, modelId: "other", thinkingLevel: "high" } };
    await start();
    const project = createProject("Project", repo.dir);

    const { sessionId } = await coord.sessions.start("Go", { projectId: project.id, kind: "coordinator" });
    expect((await coord.sessions.get(sessionId)).model).toEqual({ provider: model.model.provider, modelId: "other", thinkingLevel: "high" });
    const turn = await model.nextTurn(sessionId);
    expect(turn.modelId).toBe("other");
    turn.finish();

    const given = await coord.sessions.start("Go", { projectId: project.id, model: model.model, kind: "coordinator" });
    expect((await coord.sessions.get(given.sessionId)).model).toMatchObject({ provider: model.model.provider, modelId: "fake" });
    (await model.nextTurn(given.sessionId)).finish();

    kinds.other = { ...kinds.other, model: { provider: model.model.provider, modelId: "missing" } };
    await state.extensions.setEnabled("other", false);
    await state.extensions.setEnabled("other", true);
    await expect(other.sessions.start("Go", { projectId: project.id, kind: "coordinator" })).rejects.toThrow(`Model 'missing' not found for provider '${model.model.provider}'`);
  });

  test("names are the registering extension's: two extensions' kinds of one name are two kinds, and an extension starts only its own", async () => {
    await start();
    const project = createProject("Project", repo.dir);

    const mine = await coord.sessions.start("Go", { projectId: project.id, model: model.model, kind: "coordinator" });
    const theirs = await other.sessions.start("Go", { projectId: project.id, model: model.model, kind: "coordinator" });

    const [first, second] = [await model.nextTurn(mine.sessionId), await model.nextTurn(theirs.sessionId)];
    expect(promptOf(first)).toStartWith("You coordinate.");
    expect(promptOf(second)).toStartWith("You are the other coordinator.");
    first.finish();
    second.finish();
    expect([getSession(mine.sessionId)!.kind, getSession(theirs.sessionId)!.kind]).toEqual(["coord/coordinator", "other/coordinator"]);

    await expect(coord.sessions.start("Go", { projectId: project.id, model: model.model, kind: "other/coordinator" })).rejects.toThrow("The coord extension registers no session kind other/coordinator");
    await expect(coord.sessions.start("Go", { projectId: project.id, model: model.model, kind: "task-generator" })).rejects.toThrow("The coord extension registers no session kind task-generator");
    expect(() => coord.sessions.registerKind("coordinator", kinds.coord)).toThrow("The coord extension already registers the session kind coordinator");
    expect(() => coord.sessions.registerKind("Not a name", kinds.coord)).toThrow("Not a session kind name: Not a name");
  });

  test("a kind goes when its extension is turned off, and its sessions refuse to run, naming it, until it is back", async () => {
    await start();
    const project = createProject("Project", repo.dir);
    const { sessionId } = await coord.sessions.start("Go", { projectId: project.id, model: model.model, kind: "coordinator" });
    (await model.nextTurn(sessionId)).finish();
    await coord.sessions.wait(sessionId, 10_000);
    const views = async () => {
      const report: ExtensionView[] = await (await buildRouter().handle(makeRequest("GET", "/api/installed-extensions"), state))!.json();
      return report.map(view => [view.name, view.registrations.sessionKinds]);
    };
    expect(await views()).toEqual([["coord", ["coordinator"]], ["other", ["coordinator"]]]);

    await state.extensions.setEnabled("coord", false);

    const reason = "This session's kind, coord/coordinator, is not registered: the coord extension is turned off";
    await expect(other.sessions.send(sessionId, "Again")).rejects.toThrow(reason);
    const response = (await buildRouter().handle(makeRequest("POST", `/api/sessions/${sessionId}/prompt`, { clientId: "chat", message: [{ type: "text", text: "Again" }] }), state))!;
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: reason });
    expect((await views()).find(([name]) => name === "coord")).toEqual(["coord", []]);

    await state.extensions.setEnabled("coord", true);
    await coord.sessions.send(sessionId, "Back");
    (await model.nextTurn(sessionId)).finish();
  });

  test("a kind its extension no longer registers is refused with that reason", async () => {
    await start();
    const project = createProject("Project", repo.dir);
    const dispose = coord.sessions.registerKind("helper", { systemPrompt: () => "Help.", tools: [], environment: false });
    const { sessionId } = await coord.sessions.start("Go", { projectId: project.id, model: model.model, kind: "helper" });
    (await model.nextTurn(sessionId)).finish();
    await coord.sessions.wait(sessionId, 10_000);

    await dispose();

    await expect(coord.sessions.send(sessionId, "Again")).rejects.toThrow("This session's kind, coord/helper, is not registered: the coord extension does not register it");
  });

  test("a session's kind is fixed: what changes a session keeps it", async () => {
    await start();
    const project = createProject("Project", repo.dir);
    const { sessionId } = await coord.sessions.start("Go", { projectId: project.id, model: model.model, kind: "coordinator" });
    (await model.nextTurn(sessionId)).finish();
    await coord.sessions.wait(sessionId, 10_000);

    await coord.sessions.setModel(sessionId, model.model.provider, "other");
    await coord.sessions.setName(sessionId, "Renamed");
    await coord.sessions.setPinned(sessionId, true);
    await coord.sessions.setArchived(sessionId, true);
    await coord.sessions.send(sessionId, "Again");
    (await model.nextTurn(sessionId)).finish();

    expect(await coord.sessions.get(sessionId)).toMatchObject({ kind: "coord/coordinator", name: "Renamed" });
  });

  test("agents' scripts cannot start a kind's session; their sessions are of the agent kind", async () => {
    await start();
    const project = createProject("Project", repo.dir);
    const reins = buildApiObject(scriptContext(state, { projectId: project.id }));

    await expect(Promise.resolve().then(() => reins.sessions.start("Go", { parentSessionId: null, kind: "coordinator" }))).rejects.toThrow("options has no field \"kind\"");
    const { sessionId } = Value.Parse(SessionHandleSchema, await reins.sessions.start("Go", { parentSessionId: null, model: model.model }));
    expect(await reins.sessions.get(sessionId)).toMatchObject({ kind: "agent" });
    (await model.nextTurn(sessionId)).finish();
  });

  test("the browser's sessions give their kind and the views it declares: an agent's Changes, a kind's own, none for a kind that declares none or is not registered", async () => {
    kinds.coord = { ...kinds.coord, pinnedViews: ["coordinator-work"], mainViews: ["session", "coordinator-plan"] };
    await start();
    const project = createProject("Project", repo.dir);
    for (const [id, kind] of [["agent", "agent"], ["generator", "task-generator"], ["coordinator", "coord/coordinator"], ["other", "other/coordinator"], ["gone", "gone/coordinator"]] as const) {
      createSession(id, project.id, { agentRuntimeType: "pi", kind });
    }
    const get = async (path: string) => (await buildRouter().handle(makeRequest("GET", path), state))!.json();

    const listed: Array<{ id: string; kind: string; views: unknown }> = await get(`/api/projects/${project.id}/sessions`);
    const detail = await get("/api/sessions/coordinator");

    expect(Object.fromEntries(listed.map(session => [session.id, [session.kind, session.views]]))).toEqual({
      agent: ["agent", { pinned: ["diff-file-tree"], main: ["session", "session-changes"] }],
      generator: ["task-generator", { pinned: [], main: [] }],
      coordinator: ["coord/coordinator", { pinned: ["coordinator-work"], main: ["session", "coordinator-plan"] }],
      other: ["other/coordinator", { pinned: [], main: [] }],
      gone: ["gone/coordinator", { pinned: [], main: [] }],
    });
    expect(detail).toMatchObject({ kind: "coord/coordinator", views: { pinned: ["coordinator-work"], main: ["session", "coordinator-plan"] } });
  });

  test("a kind's views are lists of view names", async () => {
    await start();

    const pins = { ...kinds.coord };
    Reflect.set(pins, "pinnedViews", "coordinator-work");
    expect(() => coord.sessions.registerKind("pins", pins)).toThrow("Session kind pins: pinnedViews is a list of view names");
    expect(() => coord.sessions.registerKind("tabs", { ...kinds.coord, mainViews: [""] })).toThrow("Session kind tabs: mainViews is a list of view names");
  });
});

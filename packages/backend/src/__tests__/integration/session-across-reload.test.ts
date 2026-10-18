/**
 * A session running on the server across a reload (ADR-029): its runtime outlives the app that built
 * it, reaching each call's app through the process (`ServerProcess.app`), and the next app closes it once idle.
 * During the reload's gap (no app) its node calls wait, its Reins tool calls are not run and its run
 * lifecycle is applied at once: it never needed an app.
 */
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { startNode } from "@reins/node/node";
import { setApiKeyCredential } from "../../auth-credentials-store.js";
import { loadMessages } from "../../messages-store.js";
import { getSession } from "../../session-store.js";
import { registerPiProvider, unregisterPiProvider } from "../../pi/factory.js";
import { createSession } from "../../sessions/create-session.js";
import { TASK_GENERATOR_KIND } from "../../sessions/session-kinds.js";
import { latestSettlement } from "../../sessions/session-runs.js";
import { openSessionRuntime } from "../../session-runtime/live.js";
import { createProject } from "../project-fixture.js";
import { closeSessions, createAppState, type TestAppState } from "../helpers/app-state.js";
import { dialLoopback, SEEDED_NODE_ID } from "../helpers/loopback-node.js";
import { startApp, sessionEvents, sessionHost, until } from "../helpers/session-host.js";
import { useTestRepo } from "../helpers/test-repo.js";
import { useTestDb } from "../helpers/test-db.js";

setDefaultTimeout(20_000);
useTestDb();
const repo = useTestRepo();
const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).toReversed()) await cleanup(); });

test("a reload mid-run: the run continues on the new app, its tool call in flight completes and its events keep reaching the browsers; the next app closes it once idle", async () => {
  const provider = fauxProvider({ provider: "reload-faux", models: [{ id: "fake", contextWindow: 200_000, maxTokens: 1_000 }] });
  registerPiProvider(provider.provider);
  setApiKeyCredential(provider.provider.id, "test-key");
  cleanups.push(() => unregisterPiProvider(provider.provider.id));
  const host = sessionHost();
  cleanups.push(() => closeSessions(host));

  // Two apps in turn, each with its own hub; the node redials whichever is current.
  let current: TestAppState = createAppState({ process: host });
  const apps = [current];
  let stopApp = startApp(current);
  const node = startNode();
  const link = dialLoopback(current, node, { hub: () => current.nodes });
  cleanups.push(async () => { link.stop(); await node.shutdown(); for (const app of apps) await app.nodes.close(); });
  await link.ready();

  const project = createProject("Reload", repo.dir);
  const sessionId = createSession(current, project.id, { model: { provider: provider.provider.id, modelId: "fake" } }).id;
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 0.5; echo finished" }, { id: "slow" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Done"),
  ]);
  const runtime = await openSessionRuntime(host, sessionId);
  await runtime.prompt([{ type: "text", text: "Run something slow" }], { reinsId: "slow" });
  const events = () => sessionEvents(host.frames, sessionId);
  await until(() => events().some(({ event }) => event.type === "tool_execution_start"), "the tool call started");
  const beforeReload = events().length;

  // The reload: the first app stops (its hub closes, dropping the node's link), then the second starts.
  stopApp();
  await current.nodes.close();
  current = createAppState({ process: host });
  apps.push(current);
  stopApp = startApp(current);
  cleanups.push(() => stopApp());

  await until(() => latestSettlement(sessionId) !== null, "the run settled");
  expect(latestSettlement(sessionId)).toMatchObject({ status: "completed" });
  expect(JSON.stringify(loadMessages(sessionId).filter(message => message.role === "toolResult"))).toContain("finished");
  const after = events().slice(beforeReload);
  expect(after.map(({ event }) => event.type)).toContain("tool_execution_end");
  expect(after.at(-1)?.event).toMatchObject({ type: "agent_end", status: "completed" });
  expect(events().map(({ seq }) => seq)).toEqual(events().map((_, index) => index + 1));

  // A third app closes the runtime the first built, now idle, and the next open builds a new one.
  expect(host.sessions.live.get(sessionId)?.runtime).toBe(runtime);
  stopApp();
  await current.nodes.close();
  current = createAppState({ process: host });
  apps.push(current);
  stopApp = startApp(current);
  expect(host.sessions.live.has(sessionId)).toBe(false);
  expect(await openSessionRuntime(host, sessionId)).not.toBe(runtime);
});

test("the reload's gap: a session's node calls wait for the next app's link and run there, a Reins tool call is not run, and a run's lifecycle is applied at once, with no app", async () => {
  const provider = fauxProvider({ provider: "gap-faux", models: [{ id: "fake", contextWindow: 200_000, maxTokens: 1_000 }] });
  registerPiProvider(provider.provider);
  setApiKeyCredential(provider.provider.id, "test-key");
  cleanups.push(() => unregisterPiProvider(provider.provider.id));
  const host = sessionHost();
  cleanups.push(() => closeSessions(host));

  let current: TestAppState = createAppState({ process: host });
  const apps = [current];
  let stopApp = startApp(current);
  const node = startNode();
  const link = dialLoopback(current, node, { hub: () => current.nodes });
  cleanups.push(async () => { link.stop(); await node.shutdown(); for (const app of apps) await app.nodes.close(); });
  await link.ready();

  const project = createProject("Gap", repo.dir);
  const model = { provider: provider.provider.id, modelId: "fake" };
  const sessionId = createSession(current, project.id, { model }).id;
  const utilityId = createSession(current, project.id, { model, kind: TASK_GENERATOR_KIND, background: true }).id;
  const requested = Promise.withResolvers<void>();
  const gap = Promise.withResolvers<void>();
  provider.setResponses([
    async () => {
      requested.resolve();
      await gap.promise;
      return fauxAssistantMessage([
        fauxToolCall("execute", { code: "return 1" }, { id: "script" }),
        fauxToolCall("bash", { command: "echo ran-after-the-gap" }, { id: "command" }),
      ], { stopReason: "toolUse" });
    },
    fauxAssistantMessage("{}"),
    fauxAssistantMessage("Done"),
  ]);
  const runtime = await openSessionRuntime(host, sessionId);
  await runtime.prompt([{ type: "text", text: "Use the tools" }], { reinsId: "tools" });
  await requested.promise;
  const events = (id: string) => sessionEvents(host.frames, id);

  // The gap: the first app stops (its hub closes, dropping the node's link), and no app is current. The
  // next app's hub is up: the node redials it, but a session reaches a node only through an app.
  stopApp();
  await current.nodes.close();
  current = createAppState({ process: host });
  apps.push(current);
  expect(host.app).toBeUndefined();
  gap.resolve();
  await until(() => events(sessionId).some(({ event }) => event.type === "tool_execution_end" && event.toolCallId === "script"), "the script call ended");
  // A run on a kind that needs no node starts and settles meanwhile: its row is updated and announced.
  const updates = (id: string) => host.frames.map(frame => JSON.parse(frame)).filter(frame => frame.type === "session_updated" && frame.sessionId === id);
  const utility = await openSessionRuntime(host, utilityId);
  await utility.prompt([{ type: "text", text: "Generate" }], { reinsId: "generate" });
  await until(() => latestSettlement(utilityId) !== null, "the utility run settled");
  expect(latestSettlement(utilityId)).toMatchObject({ status: "completed" });
  expect(getSession(utilityId)?.activity_state).toBe("finished");
  // Its runtime's busy and idle edges, and its settlement.
  expect(updates(utilityId)).toHaveLength(3);
  await Bun.sleep(100);
  expect(events(sessionId).some(({ event }) => event.type === "tool_execution_end" && event.toolCallId === "command")).toBe(false);
  expect(getSession(sessionId)?.activity_state).toBe("running");
  expect(latestSettlement(sessionId)).toBeNull();
  await link.ready();
  expect(current.nodes.get(SEEDED_NODE_ID).connected).toBe(true);

  stopApp = startApp(current);
  cleanups.push(() => stopApp());

  await until(() => latestSettlement(sessionId) !== null, "the run settled");
  expect(latestSettlement(sessionId)).toMatchObject({ status: "completed" });
  const results = loadMessages(sessionId).filter(message => message.role === "toolResult");
  expect(JSON.stringify(results.find(result => "toolCallId" in result && result.toolCallId === "script"))).toContain("Not run: the server is reloading, try again");
  expect(JSON.stringify(results.find(result => "toolCallId" in result && result.toolCallId === "command"))).toContain("ran-after-the-gap");
});

test("a runtime opened by code other than the current app's (an older app's runtime reporting to its parent) is retired at once, for the current code to reopen once it is idle", async () => {
  const provider = fauxProvider({ provider: "code-faux", models: [{ id: "fake", contextWindow: 200_000, maxTokens: 1_000 }] });
  registerPiProvider(provider.provider);
  setApiKeyCredential(provider.provider.id, "test-key");
  cleanups.push(() => unregisterPiProvider(provider.provider.id));
  const host = sessionHost();
  cleanups.push(() => closeSessions(host));
  const state = createAppState({ process: host });
  cleanups.push(() => state.nodes.close());
  const project = createProject("Code", repo.dir);
  const model = { provider: provider.provider.id, modelId: "fake" };
  const [older, own] = [0, 1].map(() => createSession(state, project.id, { model, kind: TASK_GENERATOR_KIND, background: true }).id);

  // The current app runs other code than this test's, as a newer app's bundle does.
  const stopNewer = startApp(state, app => ({ ...app, code: Symbol("newer app") }));
  await openSessionRuntime(host, older!);
  expect(host.sessions.live.get(older!)?.retired).toBe(true);
  stopNewer();

  const stopOwn = startApp(state);
  cleanups.push(() => stopOwn());
  await openSessionRuntime(host, own!);
  expect(host.sessions.live.get(own!)?.retired).toBe(false);
});

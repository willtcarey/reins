/**
 * A session running on the server across a handler reload (ADR-029): its runtime outlives the load that
 * built it, reaching each call's load through the process's state, and the next load closes it once idle.
 */
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { startNode } from "@reins/node/node";
import { setApiKeyCredential } from "../../auth-credentials-store.js";
import { loadMessages } from "../../messages-store.js";
import { registerPiProvider, unregisterPiProvider } from "../../pi/factory.js";
import { createSession } from "../../sessions/create-session.js";
import { latestSettlement } from "../../sessions/session-runs.js";
import { openSessionRuntime } from "../../session-runtime/live.js";
import type { Server, ServerState } from "../../state.js";
import { createProject } from "../project-fixture.js";
import { createServerState } from "../helpers/server-state.js";
import { dialLoopback } from "../helpers/loopback-node.js";
import { closeLiveRuntimes, serveLoad, sessionEvents, sessionHost, until } from "../helpers/session-host.js";
import { useTestRepo } from "../helpers/test-repo.js";
import { useTestDb } from "../helpers/test-db.js";

setDefaultTimeout(20_000);
useTestDb();
const repo = useTestRepo();
const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).toReversed()) await cleanup(); });

test("a handler reload mid-run: the run continues on the new load, its tool call in flight completes and its events keep reaching the browsers; the next load closes it once idle", async () => {
  const provider = fauxProvider({ provider: "reload-faux", models: [{ id: "fake", contextWindow: 200_000, maxTokens: 1_000 }] });
  registerPiProvider(provider.provider);
  setApiKeyCredential(provider.provider.id, "test-key");
  cleanups.push(() => unregisterPiProvider(provider.provider.id));
  const host = sessionHost();
  cleanups.push(() => closeLiveRuntimes(host));

  // Two handler loads in turn, each with its own hub; the node redials whichever serves.
  let current: ServerState = createServerState({ clients: host.clients, sessions: host.sessions });
  const loads = [current];
  const settledBy: string[] = [];
  const observed = (name: string) => (server: Server): Server => ({
    ...server, credentials: server.credentials, runSettled: report => { settledBy.push(name); return server.runSettled(report); },
  });
  let stopLoad = serveLoad(host, current, observed("first"));
  const node = startNode();
  const link = dialLoopback(current, node, { hub: () => current.nodes });
  cleanups.push(async () => { link.stop(); await node.shutdown(); for (const load of loads) await load.nodes.close(); });
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

  // The reload: the first load stops (its hub closes, dropping the node's link), then the second serves.
  stopLoad();
  await current.nodes.close();
  current = createServerState({ clients: host.clients, sessions: host.sessions });
  loads.push(current);
  stopLoad = serveLoad(host, current, observed("second"));
  cleanups.push(() => stopLoad());

  await until(() => latestSettlement(sessionId) !== null, "the run settled");
  expect(latestSettlement(sessionId)).toMatchObject({ status: "completed" });
  expect(settledBy).toEqual(["second"]);
  expect(JSON.stringify(loadMessages(sessionId).filter(message => message.role === "toolResult"))).toContain("finished");
  const after = events().slice(beforeReload);
  expect(after.map(({ event }) => event.type)).toContain("tool_execution_end");
  expect(after.at(-1)?.event).toMatchObject({ type: "agent_end", status: "completed" });
  expect(events().map(({ seq }) => seq)).toEqual(events().map((_, index) => index + 1));

  // A third load closes the runtime the first built, now idle, and the next open builds a new one.
  expect(host.sessions.live.get(sessionId)?.runtime).toBe(runtime);
  stopLoad();
  await current.nodes.close();
  current = createServerState({ clients: host.clients, sessions: host.sessions });
  loads.push(current);
  stopLoad = serveLoad(host, current);
  expect(host.sessions.live.has(sessionId)).toBe(false);
  expect(await openSessionRuntime(host, sessionId)).not.toBe(runtime);
});

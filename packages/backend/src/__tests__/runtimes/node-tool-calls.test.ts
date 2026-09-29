import { test, expect } from "bun:test";
import { nodeRuntimesForTesting, startNode } from "@reins/node/node";
import { connectNode } from "@reins/node/node-connection";
import { createLoopbackPair } from "@reins/node-protocol/testing";
import { protocolVersion } from "@reins/node-protocol";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { getDb } from "../../db.js";
import { createServerTransport } from "../../node-transport/server-peer.js";
import { nodeServerHandlers } from "../../runtimes/node-server-handlers.js";
import { nodeServerServices } from "../../runtimes/node-hub.js";
import { createSource, defaultSource } from "../../node-store.js";
import { sessionTarget } from "../../runtimes/node-source.js";
import { loopbackNodeFor, stopLoopbackNode } from "../helpers/loopback-node.js";
import { registerPiProvider, unregisterPiProvider } from "../helpers/pi-providers.js";
import { setApiKeyCredential } from "../../auth-credentials-store.js";
import { setSetting } from "../../settings-store.js";
import { createProject } from "../../project-store.js";
import { createTask, getTask, listTasks } from "../../task-store.js";
import { createSession, getSession, listSessions } from "../session-fixture.js";
import { setupTestDb, teardownTestDb } from "../helpers/test-db.js";
import { createTestRepo } from "../helpers/test-repo.js";
import { createServerState } from "../helpers/server-state.js";

/** Each test gets a git-backed project with a task session and a scratch session on the node, a session
 * of that project on another node's source, and a second project the node must not be able to reach. */
async function fixture(providerName: string, responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0]) {
  setupTestDb();
  const repo = await createTestRepo();
  const otherRepo = await createTestRepo();
  const provider = fauxProvider({ provider: providerName, models: [{ id: "fake", contextWindow: 200_000, maxTokens: 1_000 }] });
  provider.setResponses(responses);
  registerPiProvider(provider.provider);
  setApiKeyCredential(provider.provider.id, "test-key");
  setSetting("default_model", { provider: provider.provider.id, modelId: "fake", runtimeType: "pi", thinkingLevel: "low" });
  const state = createServerState();
  const project = createProject("Scoped", repo.dir, "main");
  const other = createProject("Other", otherRepo.dir, "main");
  const source = defaultSource(project.id)!;
  const task = createTask(project.id, "Current task", null, "main");
  createSession("owned", project.id, { agentRuntimeType: "pi", sourceId: source.id, taskId: task.id });
  createSession("scratch", project.id, { agentRuntimeType: "pi", sourceId: source.id });
  getDb().exec("INSERT INTO nodes (id, name) VALUES ('remote', 'Remote')");
  createSession("foreign", project.id, { agentRuntimeType: "pi", sourceId: createSource(project.id, "remote", `${repo.dir}-remote`).id });
  createSession("elsewhere", other.id, { agentRuntimeType: "pi", sourceId: defaultSource(other.id)!.id });
  const cleanup = async () => {
    state.nodes.close(); await stopLoopbackNode(state); unregisterPiProvider(provider.provider.id);
    teardownTestDb(); repo.cleanup(); otherRepo.cleanup();
  };
  return { state, project, other, task, cleanup };
}

/** The node half of a link through the hub, as a node process would see it. */
function nodeLink(state: ReturnType<typeof createServerState>) {
  const node = startNode();
  const [serverEnd, nodeEnd] = createLoopbackPair();
  state.nodes.accept(serverEnd, {});
  const connection = connectNode(node, nodeEnd, "internal");
  nodeEnd.onmessage = connection.receive; nodeEnd.onclose = connection.close;
  return { connection, serverEnd, close: async () => { serverEnd.close(); await node.shutdown(); } };
}

test("script.execute, script.search and project.createTask run for the calling session with scope from the server's row", async () => {
  const { state, project, other, task, cleanup } = await fixture("tool-rpc-faux", Array.from({ length: 4 }, () => fauxAssistantMessage("ok")));
  const link = nodeLink(state);
  try {
    const { connection } = link;
    expect(await connection.executeScript({ sessionId: "owned", code: "return { project: api.projects.current().name, task: api.tasks.current().id }" }))
      .toEqual({ ok: true, text: JSON.stringify({ project: "Scoped", task: task.id }, null, 2) });
    // Script errors are results, not RPC failures; their message is unchanged.
    expect(await connection.executeScript({ sessionId: "owned", code: `throw new Error("${"x".repeat(3000)}")` }))
      .toEqual({ ok: false, error: "x".repeat(3000) });
    // Scope follows the named session's own row, never a scope chosen by the node.
    expect(await connection.executeScript({ sessionId: "elsewhere", code: "return api.projects.current().id" })).toEqual({ ok: true, text: String(other.id) });

    const search = await connection.searchScript({ sessionId: "owned", query: "tasks.list" });
    expect(search.text).toContain("## API documentation");
    expect(search.matchCount).toBeGreaterThan(0);

    const plain = await connection.createTask({ sessionId: "owned", title: "Plain task", description: "No session" });
    expect(plain).toMatchObject({ sessionStarting: false, task: { title: "Plain task", project_id: project.id } });
    expect(getTask(plain.task.id)).toMatchObject({ title: "Plain task" });
    expect(listSessions({ taskId: plain.task.id })).toEqual([]);

    const prompted = await connection.createTask({ sessionId: "scratch", title: "Prompted task", description: "Starts work", prompt: "Begin" });
    expect(prompted).toMatchObject({ sessionStarting: true, task: { project_id: project.id } });
    for (let i = 0; i < 200 && listSessions({ taskId: prompted.task.id }).length === 0; i++) await Bun.sleep(5);
    // The started session inherits the caller's project and source.
    expect(listSessions({ taskId: prompted.task.id })).toMatchObject([{ project_id: project.id, source_id: getSession("scratch")!.source_id }]);
  } finally { await link.close(); await cleanup(); }
}, 20_000);

test("tool calls for unknown sessions or sessions on another node are rejected before any product code runs", async () => {
  const { state, project, cleanup } = await fixture("tool-scope-faux", []);
  const link = nodeLink(state);
  try {
    const { connection } = link;
    const tasksBefore = listTasks(project.id).length;
    for (const sessionId of ["foreign", "missing"]) {
      const message = sessionId === "foreign" ? "Node session unavailable: foreign" : "Session not found: missing";
      await expect(connection.executeScript({ sessionId, code: "return api.tasks.create('x')" })).rejects.toMatchObject({ code: -32000, message });
      await expect(connection.searchScript({ sessionId, query: "" })).rejects.toMatchObject({ code: -32000, message });
      await expect(connection.createTask({ sessionId, title: "Denied", description: "d" })).rejects.toMatchObject({ code: -32000, message });
    }
    expect(listTasks(project.id)).toHaveLength(tasksBefore);
  } finally { await link.close(); await cleanup(); }
});

test("a node cannot widen scope by sending project or task fields", async () => {
  const { state, cleanup } = await fixture("tool-widen-faux", []);
  const frames: Array<{ id?: number; result?: { epoch: string }; error?: { code: number } }> = [];
  const services = nodeServerServices(state);
  const server = createServerTransport({ send: data => frames.push(JSON.parse(data)), close: () => {} }, nodeId => nodeServerHandlers(nodeId, services));
  try {
    server.receive(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "node.hello", params: { minVersion: protocolVersion, maxVersion: protocolVersion, capabilities: [], nodeId: "n", liveSessions: [] } }));
    await Bun.sleep(1);
    const epoch = frames[0]!.result!.epoch;
    server.receive(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "script.execute", params: { epoch, sessionId: "owned", callId: "c", code: "return 1", projectId: 999 } }));
    server.receive(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "project.createTask", params: { epoch, sessionId: "owned", title: "t", description: "d", taskId: 1 } }));
    server.receive(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "script.search", params: { epoch: crypto.randomUUID(), sessionId: "owned", query: "" } }));
    await Bun.sleep(1);
    expect(frames.slice(1).map(frame => [frame.id, frame.error?.code])).toEqual([[2, -32602], [3, -32602], [4, -32003]]);
  } finally { server.close(); await cleanup(); }
});

test("a session's model calls execute, search and create_task over the node link", async () => {
  const { state, project, cleanup } = await fixture("tool-chain-faux", [
    fauxAssistantMessage([
      fauxToolCall("execute", { code: "return api.projects.current().name" }, { id: "exec" }),
      fauxToolCall("search", { query: "sessions.wait" }, { id: "search" }),
      fauxToolCall("create_task", { title: "From the model", description: "Created over the link" }, { id: "task" }),
    ], { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  try {
    const node = loopbackNodeFor(state);
    // The scratch session has no model of its own: the default model seeds its lane.
    const { nodeId: _nodeId, ...target } = sessionTarget("scratch");
    await node.prompt({ ...target, sessionId: "scratch", clientId: "c", content: [{ type: "text", text: "Go" }], sourceSessionId: null });
    const runtime = await nodeRuntimesForTesting(node).open("scratch", target);
    await runtime.waitForIdle();
    const results = Object.fromEntries((await runtime.getMessages()).filter(message => message.role === "toolResult")
      .map(message => [message.toolCallId, { text: (message.content ?? []).map(block => block.type === "text" ? block.text : "").join(""), details: message.details }]));
    expect(results.exec).toEqual({ text: "Scoped", details: { success: true } });
    expect(results.search!.text).toContain("wait(");
    const created = JSON.parse(results.task!.text);
    expect(created).toMatchObject({ title: "From the model", project_id: project.id });
    expect(results.task!.details).toEqual(created);
    await nodeRuntimesForTesting(node).close("scratch");
  } finally { await cleanup(); }
}, 20_000);

import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { APPLICATION_ERROR, NotConnected, RpcFailure, contentImages, type LaneSeed, type OpenStreamSource, type SessionEventReport, type SessionSettled } from "@reins/node-protocol";
import { nodeRuntimesForTesting as runtimes, startNode, type NodeServer, type RuntimeTarget } from "./node.js";
import { registerPiProvider, unregisterPiProvider } from "./runtime/context.js";
import { NodeModelNotFoundError } from "./runtime/build.js";
import { piStorageServer } from "./testing/storage-server.js";

/** The server's credential service as a node sees it: every provider has an API key. */
const serverCredentials = {
  getCredential: async () => ({ type: "api_key" as const, key: "test" }),
  refreshCredential: async () => ({ type: "api_key" as const, key: "test" }),
  listCredentials: async () => [],
};
const unexpected = (what: string) => async () => { throw new Error(`unexpected ${what}`); };
/** A server connection serving Pi's storage from `storage` (the server's canonical copy) and credentials
 * for every provider; it answers lifecycle reports and drops events, and anything else is unexpected
 * unless `overrides` serves it. */
function testServer(storage: ReturnType<typeof piStorageServer>, overrides: Partial<NodeServer> = {}): NodeServer {
  return {
    ...serverCredentials, readStorage: storage.readStorage, commitStorage: storage.commitStorage,
    started: async () => {}, settled: async () => {}, event: () => {}, fetchAttachment: async () => null,
    storeAttachment: unexpected("attachment store"), executeScript: unexpected("tool call"),
    searchScript: unexpected("tool call"), createTask: unexpected("tool call"),
    ...overrides,
  };
}
/** Registers a faux provider (model `fake` unless `models` says otherwise) answering `responses` in order. */
function faux(id: string, responses: Array<string | FauxResponseFactory>, models: NonNullable<Parameters<typeof fauxProvider>[0]>["models"] = [{ id: "fake", contextWindow: 200_000, maxTokens: 1_000 }]) {
  const provider = fauxProvider({ provider: id, models });
  provider.setResponses(responses.map(response => typeof response === "string" ? fauxAssistantMessage(response) : response));
  registerPiProvider(provider.provider);
  return provider;
}
/** A response that never answers on its own: only an abort ends it. `reached` resolves once it is asked. */
function hanging() {
  const reached = Promise.withResolvers<void>();
  const response: FauxResponseFactory = (_context, options) => new Promise(resolve => {
    reached.resolve();
    options?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("", { stopReason: "aborted" })));
  });
  return { reached: reached.promise, response };
}
/** A response held until `release()`. */
function gated(text: string) {
  const reached = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const response: FauxResponseFactory = async () => { reached.resolve(); await gate.promise; return fauxAssistantMessage(text); };
  return { reached: reached.promise, release: () => gate.resolve(), response };
}
const until = async (condition: () => boolean) => { for (let i = 0; i < 200 && !condition(); i++) await Bun.sleep(5); expect(condition()).toBe(true); };

const binding = { sourceId: 7, cwd: "/tmp/reins-node", createdAt: "2026-01-01T00:00:00.000Z", parentSessionId: null };
const lane = (provider: string | null, thinkingLevel: string | null = null): LaneSeed => ({ model: provider ? { provider, modelId: "fake" } : null, thinkingLevel });
const scratch = (provider: string | null, thinkingLevel?: string | null): RuntimeTarget => ({ binding, task: null, lane: lane(provider, thinkingLevel) });
const sessionInput = (sessionId: string, clientId: string, text: string, target: RuntimeTarget) =>
  ({ sessionId, ...target, clientId, content: [{ type: "text" as const, text }], sourceSessionId: null });
/** The role of each entry the server holds for the session, in order (an entry's type unless it is a message). */
const roles = (storage: ReturnType<typeof piStorageServer>, sessionId: string) =>
  storage.session(sessionId).contents().entries.map(entry => entry.type === "message" ? entry.message.role : entry.type);
const NO_MODEL = "AgentHarness Pi runtime requires an explicit model";

test("every startNode() is its own node: runtimes are held per node and shutting one down leaves the other serving", async () => {
  const provider = faux("node-own-faux", ["ok"]);
  const storage = piStorageServer();
  const [a, b] = [startNode(), startNode()];
  a.attach(testServer(storage));
  try {
    await a.prompt(sessionInput("s", "c", "go", scratch(provider.provider.id)));
    await (await runtimes(a).open("s", scratch(provider.provider.id))).waitForIdle();
    expect([runtimes(a).has("s"), runtimes(b).has("s")]).toEqual([true, false]);
    // Abort never opens a runtime.
    expect(await b.abort({ sessionId: "s", binding })).toEqual({ aborted: false });
    expect(runtimes(b).has("s")).toBe(false);
    await a.shutdown();
    expect(runtimes(a).has("s")).toBe(false);
    await expect(a.abort({ sessionId: "s", binding })).rejects.toThrow("Node stopped");
    expect(await b.abort({ sessionId: "s", binding })).toEqual({ aborted: false });
  } finally { await a.shutdown(); await b.shutdown(); unregisterPiProvider(provider.provider.id); }
});

test("the newest attached server connection fetches prompt attachments before admission", async () => {
  const bytes = Buffer.from("abc");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const storage = piStorageServer();
  const node = startNode();
  const detachStale = node.attach(testServer(storage));
  let fetches = 0;
  node.attach(testServer(storage, { fetchAttachment: async () => { fetches++; return { data: bytes, mimeType: "image/png", byteSize: bytes.length, sha256 }; } }));
  detachStale();
  const image = { type: "image" as const, attachmentId: "new-image", mimeType: "image/png" as const, byteSize: bytes.length };
  try {
    // Fetched and verified, then the open stops for want of a model (no lane seed).
    await expect(node.prompt({ ...sessionInput("s", "image", "", scratch(null)), content: [image] })).rejects.toThrow(NO_MODEL);
    expect(fetches).toBe(1);
    // An attachment the server does not hold rejects the prompt; with no connection (past the reconnect
    // wait) the fetch is retryable.
    node.attach(testServer(storage));
    await expect(node.prompt({ ...sessionInput("s", "missing", "", scratch(null)), content: [{ ...image, attachmentId: "missing" }] }))
      .rejects.toMatchObject({ error: { code: "invalid_request", message: "Attachment unavailable: missing", retryable: false } });
    const offline = startNode({ reconnectWaitMs: 0 });
    await expect(offline.prompt({ ...sessionInput("s", "offline", "", scratch(null)), content: [image] })).rejects.toMatchObject({ error: {
      code: "unavailable", message: "Attachment fetch failed: Reins server connection unavailable", retryable: true } });
    await offline.shutdown();
  } finally { await node.shutdown(); }
});

test("a node runs Pi over the server's storage: prompt and steer replays are admitted once, events and lifecycle reports reach the connection in order", async () => {
  const provider = faux("node-run-faux", ["first", "second"]);
  const storage = piStorageServer();
  const events: string[] = [];
  const seqs: number[] = [];
  const reports: string[] = [];
  const node = startNode();
  node.attach(testServer(storage, {
    event: ({ seq, event }: SessionEventReport) => { seqs.push(seq); events.push(JSON.parse(event).type); },
    started: async ({ runId }) => { reports.push(`started:${runId}`); },
    settled: async ({ runId, status }) => { reports.push(`settled:${runId}:${status}`); },
  }));
  const target = scratch(provider.provider.id);
  try {
    const prompt = sessionInput("s", "c", "hello", target);
    expect(await node.prompt(prompt)).toEqual({ inputId: "c" });
    // A replay (its reply lost) is recognized by Pi's durable input ID, not re-admitted.
    expect(await node.prompt(prompt)).toEqual({ inputId: "c" });
    const runtime = await runtimes(node).open("s", target);
    expect(await runtimes(node).open("s", target)).toBe(runtime);
    await runtime.waitForIdle();
    const steer = sessionInput("s", "d", "unacknowledged", target);
    expect(await node.steer(steer)).toEqual({ inputId: "d" });
    expect(await node.steer(steer)).toEqual({ inputId: "d" });
    await runtime.waitForIdle();
    // The transcript is the server's: every commit went there.
    expect(roles(storage, "s")).toEqual(["reinsInput", "assistant", "reinsInput", "assistant"]);
    expect(events).toContain("agent_end");
    expect(seqs).toEqual(seqs.map((_, index) => index + 1));
    await until(() => reports.length === 4);
    expect(reports.map(report => report.split(":")[0])).toEqual(["started", "settled", "started", "settled"]);
    expect(reports.filter(report => report.startsWith("settled")).every(report => report.endsWith(":completed"))).toBe(true);
    expect(node.liveSessions()).toEqual([]);
  } finally { await node.shutdown(); unregisterPiProvider(provider.provider.id); }
});

test("runtimes outlive a connection: a run finishes over the newest one; with none attached past the reconnect wait it fails at its next commit and the next command reopens from the server", async () => {
  const first = gated("through a redial");
  const second = gated("lost");
  const provider = faux("node-redial-faux", [first.response, second.response, "recovered", "reopened"]);
  const storage = piStorageServer();
  const settledOn: string[] = [];
  const connection = (name: string, overrides: Partial<NodeServer> = {}) =>
    testServer(storage, { settled: async ({ status }) => { settledOn.push(`${name}:${status}`); }, ...overrides });
  const node = startNode({ reconnectWaitMs: 50 });
  const target = scratch(provider.provider.id);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const errors = spyOn(console, "error").mockImplementation(() => {});
  try {
    // A report the attached connection cannot deliver is lost (logged), not held for a later one.
    const detachA = node.attach(connection("a", { started: async () => { throw new RpcFailure("unavailable", "Connection closed"); } }));
    await node.prompt(sessionInput("s", "a", "go", target));
    const runtime = await runtimes(node).open("s", target);
    await first.reached;
    expect(node.liveSessions()).toEqual(["s"]);
    // A quick redial: the run commits and settles over the new connection.
    detachA();
    const detachB = node.attach(connection("b"));
    first.release();
    await runtime.waitForIdle();
    await until(() => settledOn.length === 1);
    expect(settledOn).toEqual(["b:completed"]);
    expect(warn.mock.calls.map(([message]) => String(message))).toContain("Lifecycle report for s lost:");
    expect(roles(storage, "s")).toEqual(["reinsInput", "assistant"]);

    await node.prompt(sessionInput("s", "b", "again", target));
    await second.reached;
    detachB();
    second.release();
    // Its commit failed, faulting Pi's harness: the run is not live, and its settlement has no connection
    // to go to (the server settles it as interrupted when the node reconnects without it).
    await expect(runtime.waitForIdle()).rejects.toThrow("AgentHarness storage or invariant fault");
    expect(roles(storage, "s")).toEqual(["reinsInput", "assistant", "reinsInput"]);
    expect(node.liveSessions()).toEqual([]);
    expect(settledOn).toHaveLength(1);

    node.attach(connection("c"));
    await node.prompt(sessionInput("s", "c", "once more", target));
    const reopened = await runtimes(node).open("s", target);
    expect(reopened).not.toBe(runtime);
    await reopened.waitForIdle();
    // Pi recovers the interrupted run from the server's copy, then runs the new prompt.
    expect((await reopened.getMessages()).at(-1)).toMatchObject({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "reopened" }] });
    expect(roles(storage, "s").slice(-2)).toEqual(["reinsInput", "assistant"]);
  } finally { warn.mockRestore(); errors.mockRestore(); await node.shutdown(); unregisterPiProvider(provider.provider.id); }
});

test("storage calls and reports that could not be sent wait for the node to reconnect and go over the new connection", async () => {
  const run = gated("after the reload");
  const provider = faux("node-reconnect-faux", [run.response]);
  const storage = piStorageServer();
  let closed = false;
  const settledOn: string[] = [];
  const node = startNode({ reconnectWaitMs: 5_000 });
  // The first connection closed under the run (a server handler reload) and is detached a little later.
  const detachA = node.attach(testServer(storage, {
    commitStorage: async input => { if (closed) throw new NotConnected("Connection closed"); return storage.commitStorage(input); },
    settled: async () => { settledOn.push("a"); },
  }));
  const target = scratch(provider.provider.id);
  try {
    await node.prompt(sessionInput("s", "a", "go", target));
    const runtime = await runtimes(node).open("s", target);
    await run.reached;
    closed = true;
    run.release();
    await Bun.sleep(20);
    detachA();
    await Bun.sleep(20);
    // Still waiting: the run is live and nothing it committed since is lost.
    expect(node.liveSessions()).toEqual(["s"]);
    expect(roles(storage, "s")).toEqual(["reinsInput"]);
    node.attach(testServer(storage, { settled: async ({ status }) => { settledOn.push(`b:${status}`); } }));
    await runtime.waitForIdle();
    expect(roles(storage, "s")).toEqual(["reinsInput", "assistant"]);
    await until(() => settledOn.length === 1);
    expect(settledOn).toEqual(["b:completed"]);
  } finally { await node.shutdown(); unregisterPiProvider(provider.provider.id); }
});

test("a command that arrives with no connection attached opens its runtime once the node reconnects", async () => {
  const provider = faux("node-open-reconnect-faux", ["opened"]);
  const storage = piStorageServer();
  const node = startNode({ reconnectWaitMs: 5_000 });
  const target = scratch(provider.provider.id);
  try {
    // Opening reads the lane and the provider's credentials from the server.
    const admitted = node.prompt(sessionInput("s", "a", "go", target));
    await Bun.sleep(20);
    node.attach(testServer(storage));
    expect(await admitted).toEqual({ inputId: "a" });
    await (await runtimes(node).open("s", target)).waitForIdle();
    expect(roles(storage, "s")).toEqual(["reinsInput", "assistant"]);
  } finally { await node.shutdown(); unregisterPiProvider(provider.provider.id); }
});

test("a storage call in flight when the link drops fails the run and is not sent again", async () => {
  const run = gated("unknown");
  const provider = faux("node-in-flight-faux", [run.response]);
  const storage = piStorageServer();
  let drop = false;
  const commitsOnB: unknown[] = [];
  const node = startNode({ reconnectWaitMs: 5_000 });
  const target = scratch(provider.provider.id);
  const detachA = node.attach(testServer(storage, {
    commitStorage: async input => {
      if (!drop) return storage.commitStorage(input);
      // Sent, and the link dropped before the reply: the server may have applied it.
      detachA();
      node.attach(testServer(storage, { commitStorage: async next => { commitsOnB.push(next); return storage.commitStorage(next); } }));
      throw new RpcFailure("unavailable", "Connection closed; outcome unknown", "unknown");
    },
  }));
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const errors = spyOn(console, "error").mockImplementation(() => {});
  try {
    await node.prompt(sessionInput("s", "a", "go", target));
    const runtime = await runtimes(node).open("s", target);
    await run.reached;
    drop = true;
    run.release();
    await expect(runtime.waitForIdle()).rejects.toThrow("AgentHarness storage or invariant fault");
    expect(commitsOnB).toEqual([]);
    expect(node.liveSessions()).toEqual([]);
  } finally { warn.mockRestore(); errors.mockRestore(); await node.shutdown(); unregisterPiProvider(provider.provider.id); }
});

test("a run whose storage call fails while connected is settled failed by the node, once", async () => {
  const run = gated("refused");
  const provider = faux("node-fault-settle-faux", [run.response]);
  const storage = piStorageServer();
  let refuse = false;
  const reports: string[] = [];
  const node = startNode();
  node.attach(testServer(storage, {
    commitStorage: async input => {
      if (refuse) throw new RpcFailure(APPLICATION_ERROR, "Node session unavailable: s");
      return storage.commitStorage(input);
    },
    started: async ({ runId }) => { reports.push(`started ${runId}`); },
    settled: async ({ runId, status, error }) => { reports.push(`settled ${runId} ${status} ${error?.message}`); },
  }));
  const target = scratch(provider.provider.id);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const errors = spyOn(console, "error").mockImplementation(() => {});
  try {
    await node.prompt(sessionInput("s", "a", "go", target));
    const runtime = await runtimes(node).open("s", target);
    await run.reached;
    refuse = true;
    run.release();
    // Pi faults its harness and never ends the run itself; the server hears of it at once.
    await expect(runtime.waitForIdle()).rejects.toThrow("AgentHarness storage or invariant fault");
    await until(() => reports.length === 2);
    const runId = reports[0]!.slice("started ".length);
    expect(reports).toEqual([`started ${runId}`, `settled ${runId} failed Session storage failed: Node session unavailable: s`]);
    expect(node.liveSessions()).toEqual([]);
  } finally { warn.mockRestore(); errors.mockRestore(); await node.shutdown(); unregisterPiProvider(provider.provider.id); }
});

test("a command whose storage call fails under it is retried once on a runtime reopened from the server", async () => {
  const provider = faux("node-stale-faux", ["one", "two"]);
  const storage = piStorageServer();
  let failCommits = 0;
  const node = startNode();
  node.attach(testServer(storage, {
    commitStorage: async input => {
      if (failCommits > 0) { failCommits--; throw new RpcFailure("unavailable", "Call timed out; outcome unknown", "unknown"); }
      return storage.commitStorage(input);
    },
  }));
  const target = scratch(provider.provider.id);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const errors = spyOn(console, "error").mockImplementation(() => {});
  try {
    await node.prompt(sessionInput("s", "a", "go", target));
    const runtime = await runtimes(node).open("s", target);
    await runtime.waitForIdle();
    failCommits = 1;
    // The admission commit fails and faults Pi's harness: the prompt is admitted on a fresh runtime.
    expect(await node.prompt(sessionInput("s", "b", "again", target))).toEqual({ inputId: "b" });
    const reopened = await runtimes(node).open("s", target);
    expect(reopened).not.toBe(runtime);
    await reopened.waitForIdle();
    expect(roles(storage, "s")).toEqual(["reinsInput", "assistant", "reinsInput", "assistant"]);
    // Only one retry: a command that fails again on the fresh runtime fails.
    failCommits = 2;
    await expect(node.prompt(sessionInput("s", "c", "fails", target))).rejects.toThrow("AgentHarness storage or invariant fault");
    expect(roles(storage, "s")).toHaveLength(4);
  } finally { warn.mockRestore(); errors.mockRestore(); await node.shutdown(); unregisterPiProvider(provider.provider.id); }
});

test("runs read credentials through the newest attached connection, re-read when a new one attaches", async () => {
  const keys: Array<string | undefined> = [];
  const reply: FauxResponseFactory = (_context, options) => { keys.push(options?.apiKey); return fauxAssistantMessage("ok"); };
  const id = "node-cred-faux";
  const provider = fauxProvider({ provider: id, models: [{ id: "fake", contextWindow: 200_000, maxTokens: 1_000 }] });
  provider.setResponses([reply, reply, reply]);
  // Requires a stored API key: no ambient fallback.
  registerPiProvider({ ...provider.provider, auth: { apiKey: { name: "Test key",
    resolve: async ({ credential }) => credential?.key ? { auth: { apiKey: credential.key } } : undefined } } });
  const storage = piStorageServer();
  const reads: string[] = [];
  const keyed = (key: string) => testServer(storage, { getCredential: async (providerId: string) => {
    if (providerId === id) reads.push(key);
    return { type: "api_key" as const, key };
  } });
  const node = startNode();
  const target = scratch(id);
  const run = async (clientId: string) => {
    await node.prompt(sessionInput("s", clientId, "go", target));
    await (await runtimes(node).open("s", target)).waitForIdle();
  };
  try {
    node.attach(keyed("sk-a"));
    await run("a");
    await run("b");
    node.attach(keyed("sk-b"));
    await run("c");
    expect(keys).toEqual(["sk-a", "sk-a", "sk-b"]);
    expect(reads).toEqual(["sk-a", "sk-b"]);
  } finally { await node.shutdown(); unregisterPiProvider(id); }
});

function childNode(providerName: string, responses: string[]) {
  const provider = faux(providerName, responses);
  const node = startNode();
  const received: Array<{ kind: string; settled?: SessionSettled; runId?: string }> = [];
  const storage = piStorageServer();
  node.attach(testServer(storage, {
    started: async ({ runId }) => { received.push({ kind: "started", runId }); },
    settled: async settled => { received.push({ kind: "settled", settled }); },
  }));
  const target: RuntimeTarget = { binding: { ...binding, parentSessionId: "parent" }, task: null, lane: lane(provider.provider.id) };
  const cleanup = async () => { await node.shutdown(); unregisterPiProvider(provider.provider.id); };
  return { node, target, received, provider, storage, cleanup };
}

test("a child's settlements carry committed branch tips in occurrence order without reading its transcript", async () => {
  const { node, target, received, provider, storage, cleanup } = childNode("node-child-faux", ["child answer", "second answer"]);
  try {
    await node.prompt(sessionInput("child", "c", "go", target));
    const runtime = await runtimes(node).open("child", target);
    runtime.getMessages = async () => { throw new Error("settlement must not read the transcript"); };
    await runtime.waitForIdle();
    await until(() => received.some(report => report.kind === "settled"));
    await node.prompt(sessionInput("child", "d", "again", target));
    await runtime.waitForIdle();
    await until(() => received.filter(report => report.kind === "settled").length === 2);
    const settled = received.filter(report => report.kind === "settled");
    expect(settled.map(report => ({ ...report.settled }))).toMatchObject([
      { status: "completed", metadata: { model: { provider: provider.provider.id, modelId: "fake" } }, tipId: expect.any(String) },
      { status: "completed", tipId: expect.any(String) },
    ]);
    const entries = storage.session("child").contents().entries;
    expect(settled.map(report => entries.find(entry => entry.id === report.settled!.tipId))).toMatchObject([
      { type: "message", message: { content: [{ type: "text", text: "child answer" }] } },
      { type: "message", message: { content: [{ type: "text", text: "second answer" }] } },
    ]);
    expect(received.map(report => report.kind)).toEqual(["started", "settled", "started", "settled"]);
    expect(received.map(report => report.runId ?? report.settled?.runId)).toEqual([settled[0]!.settled!.runId, settled[0]!.settled!.runId, settled[1]!.settled!.runId, settled[1]!.settled!.runId]);
  } finally { await cleanup(); }
});

test("Reins tools run on the node and call the attached server for the calling session only, once each", async () => {
  const provider = faux("node-tools-faux", [
    fauxAssistantMessage([
      fauxToolCall("execute", { code: "return 1" }, { id: "exec" }),
      fauxToolCall("search", { query: "tasks" }, { id: "search" }),
      fauxToolCall("create_task", { title: "T", description: "D", prompt: "Go" }, { id: "task" }),
    ], { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
    fauxAssistantMessage([fauxToolCall("execute", { code: "return 2" }, { id: "offline" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("offline done"),
  ].map(message => () => message));
  const storage = piStorageServer();
  const calls: unknown[] = [];
  const node = startNode();
  const detach = node.attach(testServer(storage, {
    executeScript: async input => { calls.push(["execute", input]); return { ok: true, text: "1" }; },
    searchScript: async input => { calls.push(["search", input]); throw new RpcFailure(APPLICATION_ERROR, "Node session unavailable: s"); },
    createTask: async input => { calls.push(["createTask", input]); throw new RpcFailure("unavailable", "Call timed out after 60000ms; outcome unknown", "unknown"); },
  }));
  const target = scratch(provider.provider.id);
  const runtime = await runtimes(node).open("s", target);
  const results = async () => Object.fromEntries((await runtime.getMessages()).filter(message => message.role === "toolResult")
    .map(message => [message.toolCallId, (message.content ?? []).map(block => block.type === "text" ? block.text : "").join("")]));
  try {
    await node.prompt(sessionInput("s", "a", "go", target));
    await runtime.waitForIdle();
    expect(calls).toEqual([
      ["execute", { sessionId: "s", code: "return 1" }],
      ["search", { sessionId: "s", query: "tasks" }],
      ["createTask", { sessionId: "s", title: "T", description: "D", prompt: "Go" }],
    ]);
    expect(await results()).toMatchObject({
      exec: "1",
      search: "Error: Node session unavailable: s",
      task: "Error: Call timed out after 60000ms; outcome unknown. The outcome is unknown: the task may have been created. Check the project's tasks before retrying.",
    });
    // A tool call the connection definitely did not deliver did not run.
    detach();
    node.attach(testServer(storage, { executeScript: async () => { throw new RpcFailure("unavailable", "Reins server connection unavailable"); } }));
    await node.prompt(sessionInput("s", "b", "again", target));
    await runtime.waitForIdle();
    expect((await results()).offline).toBe("Error: Reins server connection unavailable. The script did not run.");
    expect(calls).toHaveLength(3);
  } finally { await node.shutdown(); unregisterPiProvider(provider.provider.id); }
});

test("tool-result images are uploaded under node IDs before the commits that reference them, a failed upload becomes a note, providers get the bytes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reins-node-image-"));
  // 1x1 PNGs of different colours.
  const pngs = ["iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="];
  pngs.forEach((png, index) => writeFileSync(join(dir, `${index}.png`), Buffer.from(png, "base64")));
  const contexts: string[] = [];
  const seen = (index: number): FauxResponseFactory => context => { contexts.push(JSON.stringify(context.messages)); return fauxAssistantMessage(`seen ${index}`); };
  const provider = faux("node-tool-images-faux", [0, 1].flatMap(index => [
    () => fauxAssistantMessage([fauxToolCall("read", { path: `${index}.png` }, { id: `read-${index}` })], { stopReason: "toolUse" }),
    seen(index),
  ]), [{ id: "fake", input: ["text", "image"], contextWindow: 200_000, maxTokens: 1_000 }]);
  const storage = piStorageServer();
  const calls: Array<{ kind: "store"; attachmentId: string; data: Uint8Array } | { kind: "commit"; writesJson: string }> = [];
  const received: SessionEventReport[] = [];
  let uploadFails = false;
  const node = startNode();
  node.attach(testServer(storage, {
    storeAttachment: async ({ sessionId, attachmentId, data }) => {
      expect(sessionId).toBe("s");
      if (uploadFails) throw new Error("store refused");
      calls.push({ kind: "store", attachmentId, data });
    },
    commitStorage: async input => { calls.push({ kind: "commit", writesJson: JSON.stringify(input.writes) }); return storage.commitStorage(input); },
    event: report => { received.push(report); },
  }));
  const target: RuntimeTarget = { ...scratch(provider.provider.id), binding: { ...binding, cwd: dir } };
  const runtime = await runtimes(node).open("s", target);
  const imageBlock = async (id: string) => (await runtime.getMessages()).find(message => message.role === "toolResult" && message.toolCallId === id)!.content!
    .find(block => block.type === "image" || block.type === "text" && block.text.startsWith("[Image"));
  const run = async (clientId: string) => {
    const from = received.length;
    await node.prompt(sessionInput("s", clientId, "look", target));
    await runtime.waitForIdle();
    return received.slice(from).map(({ event }): unknown => JSON.parse(event));
  };
  try {
    const live = await run("a");
    const bytes = Buffer.from(pngs[0]!, "base64");
    const reference = await imageBlock("read-0");
    expect(reference).toEqual({
      type: "image", attachmentId: expect.stringMatching(/^att_[0-9a-f-]{36}$/), mimeType: "image/png", byteSize: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    const id = reference && "attachmentId" in reference ? String(reference.attachmentId) : "";
    // The upload (the node's ID, the bytes) precedes every commit naming the reference; no commit carries the bytes.
    const stored = calls.findIndex(call => call.kind === "store" && call.attachmentId === id);
    const store = calls[stored];
    expect(store?.kind === "store" && Buffer.from(store.data)).toEqual(bytes);
    const referencing = calls.flatMap((call, index) => call.kind === "commit" && call.writesJson.includes(id) ? [index] : []);
    expect(referencing.length).toBeGreaterThan(0);
    expect(referencing.every(index => index > stored)).toBe(true);
    expect(calls.every(call => call.kind === "store" || !call.writesJson.includes(pngs[0]!.slice(0, 40)))).toBe(true);
    // Live events carry the reference, never the bytes; the provider still sees the image, from the node's cache.
    const images = live.flatMap(event => contentImages(event));
    expect(images.length).toBeGreaterThan(2); // tool_execution_end, message_start/end, entry_added, turn_end, agent_end
    expect(images.every(block => block.attachmentId === id && block.data === undefined)).toBe(true);
    expect(contexts[0]).toContain(pngs[0]);

    // An image the server did not take is never referenced: the result carries a note instead.
    uploadFails = true;
    await run("b");
    expect(await imageBlock("read-1")).toEqual({ type: "text", text: "[Image omitted: upload failed: store refused]" });
    expect(contexts[1]).not.toContain(pngs[1]);
    expect(calls.every(call => call.kind === "store" ? call.attachmentId === id : !call.writesJson.includes(pngs[1]!.slice(0, 40)))).toBe(true);
  } finally { await node.shutdown(); unregisterPiProvider(provider.provider.id); rmSync(dir, { recursive: true, force: true }); }
});

test("images in history are fetched from the server only when a run hydrates them, once; one the server no longer holds becomes a placeholder", async () => {
  const bytes = Buffer.from("history image");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const contexts: string[] = [];
  const seen: FauxResponseFactory = context => { contexts.push(JSON.stringify(context.messages)); return fauxAssistantMessage("seen"); };
  const provider = faux("node-history-images-faux", [seen, seen, seen], [{ id: "fake", input: ["text", "image"], contextWindow: 200_000, maxTokens: 1_000 }]);
  const storage = piStorageServer();
  const fetched: string[] = [];
  const held = new Set(["kept", "gone"]);
  const server = testServer(storage, { fetchAttachment: async (_sessionId, attachmentId) => {
    fetched.push(attachmentId);
    return held.has(attachmentId) ? { data: bytes, mimeType: "image/png", byteSize: bytes.length, sha256 } : null;
  } });
  const target = scratch(provider.provider.id);
  const image = (attachmentId: string) => ({ type: "image" as const, attachmentId, mimeType: "image/png" as const, byteSize: bytes.length, sha256 });
  const first = startNode();
  first.attach(server);
  const second = startNode();
  second.attach(server);
  try {
    await first.prompt({ ...sessionInput("s", "a", "", target), content: [image("kept"), image("gone")] });
    await (await runtimes(first).open("s", target)).waitForIdle();
    await first.shutdown();
    held.delete("gone");
    fetched.length = 0;

    // Another node (an empty cache) opens the session: nothing is fetched until a run needs the history.
    const runtime = await runtimes(second).open("s", target);
    expect(fetched).toEqual([]);
    await second.prompt(sessionInput("s", "b", "again", target));
    await runtime.waitForIdle();
    expect(fetched.toSorted()).toEqual(["gone", "kept"]);
    expect(contexts.at(-1)).toContain(bytes.toString("base64"));
    expect(contexts.at(-1)).toContain("[Image attachment missing]");
    await second.prompt(sessionInput("s", "c", "more", target));
    await runtime.waitForIdle();
    // Cached now; only the one the server does not hold is asked for again.
    expect(fetched.toSorted()).toEqual(["gone", "gone", "kept"]);
  } finally { await first.shutdown(); await second.shutdown(); unregisterPiProvider(provider.provider.id); }
});

test("opening a task session checks out its branch in the bound workspace before building Pi", async () => {
  const repo = mkdtempSync(join(tmpdir(), "reins-node-checkout-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  git("branch", "task/feature");
  const node = startNode();
  node.attach(testServer(piStorageServer()));
  const target = (branchName: string): RuntimeTarget => ({ binding: { ...binding, cwd: repo }, task: { title: "Feature", description: null, branchName }, lane: lane(null) });
  const checkouts = () => git("reflog").split("\n").filter(line => line.includes("checkout:")).length;
  try {
    // No model stops the open right after checkout, so no Pi provider is needed.
    await expect(runtimes(node).open("s", target("task/feature"))).rejects.toThrow(NO_MODEL);
    expect(git("rev-parse", "--abbrev-ref", "HEAD")).toBe("task/feature");
    const before = checkouts();
    await expect(runtimes(node).open("s", target("task/feature"))).rejects.toThrow(NO_MODEL);
    expect(checkouts()).toBe(before); // Already on the branch: no checkout.

    await expect(runtimes(node).open("gone", target("task/missing"))).rejects.toThrow(/git checkout failed \(exit 1\):.*task\/missing/);
    expect(git("rev-parse", "--abbrev-ref", "HEAD")).toBe("task/feature");
    expect(runtimes(node).has("gone")).toBe(false);
  } finally { await node.shutdown(); rmSync(repo, { recursive: true, force: true }); }
});

test("the model lives in Pi's lane on the server: seeded from the command's lane once, set through Pi, and kept by a restarted node", async () => {
  const repo = mkdtempSync(join(tmpdir(), "reins-node-model-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  git("branch", "task/frozen");
  const provider = fauxProvider({ provider: "node-model-faux", models: [{ id: "fake" }, { id: "other" }] });
  const seen: Array<{ model: string; systemPrompt?: string }> = [];
  const reply = (text: string): FauxResponseFactory => (context, _options, _state, model) => {
    seen.push({ model: model.id, systemPrompt: context.systemPrompt });
    return fauxAssistantMessage(text);
  };
  provider.setResponses([reply("one"), reply("two")]);
  registerPiProvider(provider.provider);
  const id = provider.provider.id;
  const storage = piStorageServer();
  const laneConfig = (sessionId: string) => {
    const stored = storage.session(sessionId).contents().values.find(value => value.namespace === "pi.lane.config");
    return stored && JSON.stringify(stored.value);
  };
  const task = { title: "Frozen task", description: "From the snapshot", branchName: "task/frozen" };
  const target: RuntimeTarget = { binding: { ...binding, cwd: repo }, task, lane: lane(id, "high") };
  const setModel = (modelId: string, thinkingLevel?: string) => ({ sessionId: "s", ...target, provider: id, modelId, ...(thinkingLevel ? { thinkingLevel } : {}) });
  let node = startNode();
  try {
    node.attach(testServer(storage));
    expect(await node.prompt(sessionInput("s", "a", "go", target))).toEqual({ inputId: "a" });
    let runtime = await runtimes(node).open("s", target);
    await runtime.waitForIdle();
    // The session had no lane: Pi created it from the seed, on the server.
    expect(JSON.parse(laneConfig("s")!)).toMatchObject({ model: { provider: id, modelId: "fake" }, thinkingLevel: "high" });
    expect(runtime.getSessionMetadata()).toEqual({ model: { provider: id, modelId: "fake" }, thinkingLevel: "high" });
    expect(seen[0]?.model).toBe("fake");
    expect(seen[0]?.systemPrompt).toContain("Frozen task");
    expect(seen[0]?.systemPrompt).toContain("From the snapshot");

    // Applied to the open runtime and persisted in Pi's lane; a replay applies the same absolute selection.
    expect(await node.setModel(setModel("other", "low"))).toEqual({ modelSet: true });
    expect(runtime.getSessionMetadata()).toEqual({ model: { provider: id, modelId: "other" }, thinkingLevel: "low" });
    const applied = laneConfig("s");
    expect(JSON.parse(applied!)).toMatchObject({ model: { modelId: "other" }, thinkingLevel: "low" });
    expect(await node.setModel(setModel("other", "low"))).toEqual({ modelSet: true });
    expect(JSON.parse(laneConfig("s")!)).toEqual(JSON.parse(applied!));

    // An unknown model is an explicit rejection, without a lane change.
    await expect(node.setModel(setModel("missing"))).rejects.toMatchObject({ error: {
      code: "invalid_request", message: `Model not found: ${id}/missing`, retryable: false } });
    expect(JSON.parse(laneConfig("s")!)).toEqual(JSON.parse(applied!));

    // Applied while the runtime is closed; a restarted node reopens with Pi's stored selection, not the seed.
    await runtimes(node).close("s");
    expect(await node.setModel(setModel("fake"))).toEqual({ modelSet: true });
    await node.shutdown();
    node = startNode();
    node.attach(testServer(storage));
    runtime = await runtimes(node).open("s", target);
    // No thinking level in the command keeps Pi's current one.
    expect(runtime.getSessionMetadata()).toEqual({ model: { provider: id, modelId: "fake" }, thinkingLevel: "low" });
    await node.prompt(sessionInput("s", "b", "again", target));
    await runtime.waitForIdle();
    expect(seen.map(entry => entry.model)).toEqual(["fake", "fake"]);
    await runtimes(node).close("s");

    // A lane whose stored model is gone cannot open, but setModel repairs it.
    const removed = fauxProvider({ provider: "node-model-removed-faux", models: [{ id: "gone" }] });
    registerPiProvider(removed.provider);
    const removedTarget: RuntimeTarget = { binding: target.binding, task: null, lane: { model: { provider: removed.provider.id, modelId: "gone" }, thinkingLevel: null } };
    await runtimes(node).open("stale", removedTarget);
    await runtimes(node).close("stale");
    unregisterPiProvider(removed.provider.id);
    await expect(runtimes(node).open("stale", removedTarget)).rejects.toBeInstanceOf(NodeModelNotFoundError);
    expect(await node.setModel({ ...setModel("fake"), ...removedTarget, sessionId: "stale" })).toEqual({ modelSet: true });
    expect((await runtimes(node).open("stale", removedTarget)).getSessionMetadata().model).toEqual({ provider: id, modelId: "fake" });
  } finally { await node.shutdown(); unregisterPiProvider(id); rmSync(repo, { recursive: true, force: true }); }
});

test("a new node (no memory) converges on replays of prompt, steer and setModel against the server's state, without a duplicate effect", async () => {
  const replies: string[] = [];
  const reply = (text: string): FauxResponseFactory => () => { replies.push(text); return fauxAssistantMessage(text); };
  const provider = faux("node-restart-faux", [reply("one"), reply("two")], [{ id: "fake" }, { id: "other" }]);
  const storage = piStorageServer();
  const target = scratch(provider.provider.id);
  const prompt = sessionInput("s", "p1", "go", target);
  const steer = sessionInput("s", "s1", "and then", target);
  const setModel = { sessionId: "s", ...target, provider: provider.provider.id, modelId: "other", thinkingLevel: "low" };
  const state = () => ({
    entries: storage.session("s").contents().entries.map(({ seq, id, type }) => ({ seq, id, type })),
    // A setModel replay writes the same selection again (a new seq, the same value).
    values: storage.session("s").contents().values.map(({ namespace, key, value }) => ({ namespace, key, value })),
  });
  let node = startNode();
  try {
    node.attach(testServer(storage));
    expect(await node.prompt(prompt)).toEqual({ inputId: "p1" });
    await (await runtimes(node).open("s", target)).waitForIdle();
    expect(await node.steer(steer)).toEqual({ inputId: "s1" });
    await (await runtimes(node).open("s", target)).waitForIdle();
    expect(await node.setModel(setModel)).toEqual({ modelSet: true });
    const before = state();
    expect(replies).toEqual(["one", "two"]);

    // Every reply was lost; the node process restarts and the server replays all three.
    await node.shutdown();
    node = startNode();
    node.attach(testServer(storage));
    expect(await node.prompt(prompt)).toEqual({ inputId: "p1" });
    expect(await node.steer(steer)).toEqual({ inputId: "s1" });
    expect(await node.setModel(setModel)).toEqual({ modelSet: true });
    await (await runtimes(node).open("s", target)).waitForIdle();
    // No second input, run or model write: the replays converged on the stored state.
    expect(state()).toEqual(before);
    expect(replies).toEqual(["one", "two"]);
  } finally { await node.shutdown(); unregisterPiProvider(provider.provider.id); }
});

test("a runtime under another binding is refused busy while it runs and reopened under the new one when idle; only running sessions are live", async () => {
  const { reached, response } = hanging();
  const provider = faux("node-binding-faux", [response, "moved"]);
  const node = startNode();
  node.attach(testServer(piStorageServer()));
  const target = scratch(provider.provider.id);
  const moved: RuntimeTarget = { ...target, binding: { ...binding, sourceId: 8, cwd: "/tmp/reins-node-moved" } };
  try {
    await node.prompt(sessionInput("s", "a", "work", target));
    await runtimes(node).open("idle", target);
    const runtime = await runtimes(node).open("s", target);
    await reached;
    expect(node.liveSessions()).toEqual(["s"]);
    await expect(node.prompt(sessionInput("s", "b", "elsewhere", moved))).rejects.toMatchObject({ error: { code: "busy", retryable: false } });
    expect(runtime.isStreaming()).toBe(true);

    expect(await node.abort({ sessionId: "s", binding })).toEqual({ aborted: true });
    await runtime.waitForIdle();
    expect(node.liveSessions()).toEqual([]);
    expect(await node.prompt(sessionInput("s", "b", "elsewhere", moved))).toEqual({ inputId: "b" });
    const reopened = await runtimes(node).open("s", moved);
    expect(reopened).not.toBe(runtime);
    await reopened.waitForIdle();
    expect((await reopened.getMessages()).at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
  } finally { await node.shutdown(); unregisterPiProvider(provider.provider.id); }
});

test("close aborts a run and closes the session's runtime, and says whether one was open", async () => {
  const running = hanging();
  const provider = faux("node-close-faux", [running.response, "reopened"]);
  const settled: SessionSettled[] = [];
  const node = startNode();
  node.attach(testServer(piStorageServer(), { settled: async report => { settled.push(report); } }));
  const target = scratch(provider.provider.id);
  try {
    await node.prompt(sessionInput("s", "a", "work", target));
    const runtime = await runtimes(node).open("s", target);
    await running.reached;
    expect(await node.close({ sessionId: "s" })).toEqual({ closed: true });
    expect(runtime.isStreaming()).toBe(false);
    expect(runtimes(node).has("s")).toBe(false);
    await until(() => settled.length === 1);
    expect(settled[0]!.status).toBe("aborted");
    expect(await node.close({ sessionId: "s" })).toEqual({ closed: false });

    // The session's next command reopens it from the server.
    await node.prompt(sessionInput("s", "b", "again", target));
    await (await runtimes(node).open("s", target)).waitForIdle();
    expect(await node.close({ sessionId: "s" })).toEqual({ closed: true });
    expect(runtimes(node).has("s")).toBe(false);
  } finally { await node.shutdown(); unregisterPiProvider(provider.provider.id); }
});

test("shutdown aborts every run, closes every runtime and refuses later commands", async () => {
  const { reached, response } = hanging();
  const provider = faux("node-shutdown-faux", [response]);
  const node = startNode();
  const settled: SessionSettled[] = [];
  node.attach(testServer(piStorageServer(), { settled: async report => { settled.push(report); } }));
  const target = scratch(provider.provider.id);
  try {
    expect(await node.prompt(sessionInput("s", "a", "work", target))).toEqual({ inputId: "a" });
    const runtime = await runtimes(node).open("s", target);
    await reached;
    await node.shutdown();
    expect(runtime.isStreaming()).toBe(false);
    expect(runtimes(node).has("s")).toBe(false);
    expect(settled.map(report => report.status)).toEqual(["aborted"]);
    await expect(node.prompt(sessionInput("s", "b", "", target))).rejects.toThrow("Node stopped");
  } finally { await node.shutdown(); unregisterPiProvider(provider.provider.id); }
});

test("skills.list serves the skills of the source checkout it is given (name and description), not_found for a missing checkout", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "reins-node-skills-"));
  const node = startNode();
  try {
    mkdirSync(join(cwd, ".agents", "skills", "review"), { recursive: true });
    writeFileSync(join(cwd, ".agents", "skills", "review", "SKILL.md"), "---\nname: review\ndescription: Reviews code\n---\n\nBody");
    const { skills } = await node.listSkills({ sourceId: 7, cwd });
    expect(skills.find(skill => skill.name === "review")).toEqual({ name: "review", description: "Reviews code" });
    await expect(node.listSkills({ sourceId: 7, cwd: join(cwd, "missing") })).rejects.toMatchObject({ error: { code: "not_found" } });
  } finally { await node.shutdown(); rmSync(cwd, { recursive: true, force: true }); }
});

/** Runs a process stream's source to its end: its output and the exit it returned. */
async function drain(source: OpenStreamSource, signal = new AbortController().signal) {
  const iterator = source(signal)[Symbol.asyncIterator]();
  const output: Uint8Array[] = [];
  for (let next = await iterator.next(); ; next = await iterator.next()) {
    if (next.done) return { output: Buffer.concat(output).toString("utf8"), exit: next.value || undefined };
    output.push(typeof next.value === "string" ? Buffer.from(next.value) : next.value);
  }
}

test("process.run runs argv without a shell in the source checkout, merging env over the node's, and returns the exit with stderr", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "reins-node-process-"));
  const node = startNode();
  try {
    const literal = await drain(await node.runProcess({ sourceId: 7, cwd, streamId: "s1", argv: ["printf", "%s", "$HOME"] }));
    expect(literal).toEqual({ output: "$HOME", exit: { code: 0, signal: null, stderr: "" } });
    const script = 'printf "%s|%s" "$(pwd -P)" "$GREETING"; echo "bad things" >&2; exit 3';
    expect(await drain(await node.runProcess({ sourceId: 7, cwd, streamId: "s2", argv: ["sh", "-c", script], env: { GREETING: "hi" } })))
      .toEqual({ output: `${realpathSync(cwd)}|hi`, exit: { code: 3, signal: null, stderr: "bad things\n" } });
    await expect(node.runProcess({ sourceId: 7, cwd: join(cwd, "missing"), streamId: "s3", argv: ["true"] })).rejects.toMatchObject({ error: { code: "not_found" } });
    await expect(node.runProcess({ sourceId: 7, cwd, streamId: "s4", argv: ["no-such-program-reins"] })).rejects.toMatchObject({ error: { code: "invalid_request", message: "Program not found: no-such-program-reins" } });
  } finally { await node.shutdown(); rmSync(cwd, { recursive: true, force: true }); }
});

test("process.run kills its process when its stream is stopped", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "reins-node-process-"));
  const node = startNode();
  try {
    const source = await node.runProcess({ sourceId: 7, cwd, streamId: "s1", argv: ["sh", "-c", "echo $$; exec sleep 30"] });
    const stop = new AbortController();
    const iterator = source(stop.signal)[Symbol.asyncIterator]();
    const first = await iterator.next();
    const pid = first.value instanceof Uint8Array ? Number(Buffer.from(first.value).toString().trim()) : NaN;
    stop.abort();
    await iterator.return?.();
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (let i = 0; i < 100 && alive(); i++) await Bun.sleep(5);
    expect(alive()).toBe(false);
  } finally { await node.shutdown(); rmSync(cwd, { recursive: true, force: true }); }
});

test("fs.list lists one directory of the checkout, directories first then by name, without symlinks; it refuses paths outside the checkout", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "reins-node-fs-"));
  const node = startNode();
  try {
    mkdirSync(join(cwd, "src", "lib"), { recursive: true });
    writeFileSync(join(cwd, "src", "b.ts"), "");
    writeFileSync(join(cwd, "src", "A.ts"), "");
    mkdirSync(join(cwd, "src", "assets"));
    symlinkSync(join(cwd, "src", "b.ts"), join(cwd, "src", "link.ts"));
    expect(await node.listDirectory({ sourceId: 7, cwd, path: "src" })).toEqual({ entries: [
      { name: "assets", type: "directory" }, { name: "lib", type: "directory" }, { name: "A.ts", type: "file" }, { name: "b.ts", type: "file" },
    ] });
    expect((await node.listDirectory({ sourceId: 7, cwd, path: "." })).entries).toEqual([{ name: "src", type: "directory" }]);
    await expect(node.listDirectory({ sourceId: 7, cwd, path: "../.." })).rejects.toMatchObject({ error: { code: "invalid_request", message: "Path traversal not allowed" } });
    await expect(node.listDirectory({ sourceId: 7, cwd, path: "/etc" })).rejects.toMatchObject({ error: { code: "invalid_request" } });
    await expect(node.listDirectory({ sourceId: 7, cwd, path: "missing" })).rejects.toMatchObject({ error: { code: "not_found", message: "Directory not found" } });
  } finally { await node.shutdown(); rmSync(cwd, { recursive: true, force: true }); }
});

import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { APPLICATION_ERROR, RpcFailure, contentImages, type SessionEventReport, type SessionSettled, type SessionStarted, type SessionConfiguration } from "@reins/node-protocol";
import { nodeRuntimesForTesting as runtimes, startNode } from "./node.js";
import { nodeSessionBinding, openNodeDb } from "./storage.js";
import { registerPiProvider, unregisterPiProvider } from "./runtime/context.js";
import { NodeModelNotFoundError } from "./runtime/build.js";

/** The server's credential service as a node sees it: every provider has an API key. */
const serverCredentials = {
  getCredential: async () => ({ type: "api_key" as const, key: "test" }),
  refreshCredential: async () => ({ type: "api_key" as const, key: "test" }),
  listCredentials: async () => [],
  snapshot: async () => { throw new Error("unexpected session snapshot"); },
};
const noTools = {
  ...serverCredentials,
  executeScript: async () => { throw new Error("unexpected tool call"); },
  searchScript: async () => { throw new Error("unexpected tool call"); },
  createTask: async () => { throw new Error("unexpected tool call"); },
  storeAttachment: async () => { throw new Error("unexpected attachment store"); },
};
/** A connection that serves credentials (a run needs them) but cannot deliver anything else: commits,
 * uploads and lifecycle reports stay pending, events are dropped and tool calls do not run. */
const offline = (error: string) => async () => { throw new Error(error); };
const credentialsOnly = {
  ...serverCredentials,
  committed: offline("Server connection unavailable"), started: offline("Server connection unavailable"),
  settled: offline("Server connection unavailable"), storeAttachment: offline("Server connection unavailable"),
  fetchAttachment: offline("Server connection unavailable"), event: () => {},
  executeScript: async () => { throw new RpcFailure("unavailable", "Reins server connection unavailable"); },
  searchScript: async () => { throw new RpcFailure("unavailable", "Reins server connection unavailable"); },
  createTask: async () => { throw new RpcFailure("unavailable", "Reins server connection unavailable"); },
};
const noReports = { started: async () => {}, settled: async () => {}, ...noTools };
const scratch: SessionConfiguration = { model: null, thinkingLevel: null, task: null };
const provisionOf = (sessionId: string, configuration: SessionConfiguration = scratch) => ({ sessionId, configuration });
const NO_MODEL = "AgentHarness Pi runtime requires an explicit model";

test("every startNode(db) is its own node over the database it is given", async () => {
  const [first, second] = [openNodeDb(":memory:"), openNodeDb(":memory:")];
  const [a, b] = [startNode(first), startNode(second)];
  const binding = { sourceId: 7, cwd: "/tmp/node-owned", createdAt: "2026-01-01", parentSessionId: null };
  try {
    expect(await a.provision({ ...provisionOf("owned"), binding })).toEqual({ provisioned: true });
    expect(first.query("SELECT id, cwd FROM sessions WHERE id = 'owned'").get()).toEqual({ id: "owned", cwd: "/tmp/node-owned" });
    // The other node holds nothing of it.
    expect(nodeSessionBinding(second, "owned")).toBeNull();
    await expect(b.abort({ sessionId: "owned", binding })).rejects.toMatchObject({ error: { code: "not_found" } });
    // Shutting one down leaves the other serving.
    await a.shutdown();
    await expect(a.abort({ sessionId: "owned", binding })).rejects.toThrow("Node stopped");
    expect(await b.provision({ ...provisionOf("owned"), binding })).toEqual({ provisioned: true });
  } finally { await a.shutdown(); await b.shutdown(); first.close(); second.close(); }
});

test("opening node storage fails on an unsupported database before a node can start, keeping its data", () => {
  const dir = mkdtempSync(join(tmpdir(), "reins-node-unversioned-"));
  const path = join(dir, "storage.db");
  const old = new Database(path);
  old.exec("CREATE TABLE old_node_data(id TEXT); INSERT INTO old_node_data VALUES ('keep')");
  old.close();
  try {
    expect(() => openNodeDb(path)).toThrow(/unversioned/i);
    const db = new Database(path);
    expect(db.query("SELECT id FROM old_node_data").all()).toEqual([{ id: "keep" }]);
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 0 });
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a session missing from node storage rejects input without an ambiguous admission", async () => {
  const db = openNodeDb(":memory:");
  const node = startNode(db);
  const binding = { sourceId: 7, cwd: "/tmp/reins-node-owner", createdAt: "2026-01-01T00:00:00.000Z", parentSessionId: null };
  try {
    await expect(node.prompt({ binding, sessionId: "lost", clientId: "input", content: [{ type: "text", text: "hello" }], sourceSessionId: null }))
      .rejects.toMatchObject({ error: { code: "not_found", message: "This session's node data is missing. Start a new session.", retryable: false } });
    expect(nodeSessionBinding(db, "lost")).toBeNull();
    await expect(runtimes(node).open("lost", binding)).rejects.toThrow("This session's node data is missing. Start a new session.");
    await expect(node.resumePending({ binding, sessionId: "lost" }))
      .rejects.toMatchObject({ error: { code: "not_found", retryable: false } });
  } finally { await node.shutdown(); db.close(); }
});

test("opening a session does not fetch attachments from past inputs", async () => {
  const db = openNodeDb(":memory:");
  const node = startNode(db);
  node.attach({ committed: async () => {}, fetchAttachment: async () => { throw new Error("historical fetch"); }, event: () => {}, ...noReports });
  const binding = { sourceId: 7, cwd: "/tmp/reins-node-owner", createdAt: "2026-01-01T00:00:00.000Z", parentSessionId: null };
  try {
    await node.provision({ ...provisionOf("s"), binding });
    db.query(`INSERT INTO session_messages(session_id,seq,harness_id,role,message_json,created_at)
      VALUES(?,?,?,?,?,?)`).run("s", 1, "entry-1", "reinsInput", JSON.stringify({
        type: "message", message: { role: "reinsInput", content: [
          { type: "image", attachmentId: "old", mimeType: "image/png", byteSize: 1 },
        ] },
      }), binding.createdAt);
    // Scratch provision without a model: the open stops before Pi, after reading history.
    await expect(runtimes(node).open("s", binding)).rejects.toThrow(NO_MODEL);
    expect(db.query("SELECT 1 FROM node_attachments").get()).toBeNull();
  } finally { await node.shutdown(); db.close(); }
});

test("the newest attached server connection fetches attachments", async () => {
  const db = openNodeDb(":memory:");
  const bytes = Buffer.from("abc");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const node = startNode(db);
  const detachStale = node.attach({ committed: async () => {}, fetchAttachment: async () => null, event: () => {}, ...noReports });
  let fetches = 0;
  node.attach({ committed: async () => {}, fetchAttachment: async () => {
    fetches++;
    return { data: bytes, mimeType: "image/png", byteSize: bytes.length, sha256 };
  }, event: () => {}, ...noReports });
  detachStale();
  const binding = { sourceId: 7, cwd: "/tmp/reins-node-owner", createdAt: "2026-01-01T00:00:00.000Z", parentSessionId: null };
  try {
    expect(await node.provision({ ...provisionOf("s"), binding })).toEqual({ provisioned: true });
    await expect(node.prompt({ binding, sessionId: "s", clientId: "image", content: [
      { type: "image", attachmentId: "new-image", mimeType: "image/png", byteSize: bytes.length },
    ], sourceSessionId: null })).rejects.toThrow(NO_MODEL);
    expect(fetches).toBe(1);
    expect(db.query("SELECT data FROM node_attachments WHERE session_id = ? AND attachment_id = ?").get("s", "new-image"))
      .toEqual({ data: bytes });
  } finally { await node.shutdown(); db.close(); }
});

test("provision converges on replay by state: a crash between binding and lane, a lost reply", async () => {
  const db = openNodeDb(":memory:");
  const provider = fauxProvider({ provider: "node-provision-faux", models: [{ id: "fake" }] });
  registerPiProvider(provider.provider);
  const node = startNode(db);
  const replicated: number[] = [];
  node.attach({ ...noReports, committed: async ({ startSeq }) => { replicated.push(startSeq); }, fetchAttachment: async () => null, event: () => {} });
  const binding = { sourceId: 7, cwd: "/tmp/reins-node-provision", createdAt: "2026-01-01T00:00:00.000Z", parentSessionId: null };
  const piState = (sessionId: string) => ({
    values: db.query("SELECT namespace, key, seq, value_json FROM pi_values WHERE session_id = ? ORDER BY namespace, key").all(sessionId),
    nextSeq: db.query("SELECT harness_next_seq FROM sessions WHERE id = ?").get(sessionId),
  });
  const provision = provisionOf("s", { model: { provider: provider.provider.id, modelId: "fake" }, thinkingLevel: "high", task: null });
  try {
    // A crash after the binding was stored but before Pi created the lane: the server replays.
    db.exec("CREATE TRIGGER reject_lane BEFORE INSERT ON pi_values BEGIN SELECT RAISE(ABORT, 'lane unavailable'); END");
    await expect(node.provision({ ...provision, binding })).rejects.toThrow();
    db.exec("DROP TRIGGER reject_lane");
    expect(nodeSessionBinding(db, "s")).toEqual(binding);
    expect(piState("s").values).toEqual([]);

    // The replay converges: the binding matches and Pi creates the lane.
    expect(await node.provision({ ...provision, binding })).toEqual({ provisioned: true });
    const created = piState("s");
    expect(created.values.length).toBeGreaterThan(0);
    // A replay after success (its reply lost) is a no-op: the lane exists and is not written again.
    expect(await node.provision({ ...provision, binding })).toEqual({ provisioned: true });
    expect(piState("s")).toEqual(created);
    // Pi's lane commit replicated to the server once, through the normal commit path.
    expect(replicated).toEqual([1]);
    // Pi's lane API reads the provisioned selection.
    expect((await runtimes(node).open("s", binding)).getSessionMetadata()).toEqual({ model: { provider: provider.provider.id, modelId: "fake" }, thinkingLevel: "high" });
    await runtimes(node).close("s");

    // No resolved model: no lane until session.setModel.
    expect(await node.provision({ ...provisionOf("scratch"), binding })).toEqual({ provisioned: true });
    expect(piState("scratch").values).toEqual([]);
    await expect(runtimes(node).open("scratch", binding)).rejects.toThrow(NO_MODEL);

    // A model the node's registry does not know is rejected before anything is stored.
    const unknown = provisionOf("unknown", { model: { provider: provider.provider.id, modelId: "missing" }, thinkingLevel: null, task: null });
    await expect(node.provision({ ...unknown, binding })).rejects.toMatchObject({ error: {
      code: "invalid_request", message: `Model not found: ${provider.provider.id}/missing`, retryable: false } });
    expect(nodeSessionBinding(db, "unknown")).toBeNull();
  } finally { await node.shutdown(); unregisterPiProvider(provider.provider.id); db.close(); }
});

test("node provisions an immutable binding, executes Pi and reopens from canonical storage without product tables", async () => {
  const db = openNodeDb(":memory:");
  const provider = fauxProvider({ provider: "node-owner-faux", models: [{ id: "fake", contextWindow: 200_000, maxTokens: 1_000 }] });
  provider.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("interrupted answer"), fauxAssistantMessage("second")]);
  registerPiProvider(provider.provider);
  const events: string[] = [];
  const seqs: number[] = [];
  const reports: string[] = [];
  const recorder = {
    committed: async () => { reports.push("committed"); }, fetchAttachment: async () => null,
    event: ({ seq, event }: SessionEventReport) => { seqs.push(seq); events.push(JSON.parse(event).type); },
    started: async ({ runId }: SessionStarted) => { reports.push(`started:${runId}`); },
    settled: async ({ runId, status }: SessionSettled) => { reports.push(`settled:${runId}:${status}`); },
    ...noTools,
  };
  const binding = { sourceId: 7, cwd: "/tmp/reins-node-owner", createdAt: "2026-01-01T00:00:00.000Z", parentSessionId: null };
  const provision = provisionOf("s", { model: { provider: provider.provider.id, modelId: "fake" }, thinkingLevel: null, task: null });
  try {
    const node = startNode(db);
    const detach = node.attach(recorder);
    expect(await node.provision({ ...provision, binding })).toEqual({ provisioned: true });
    expect(await node.provision({ ...provision, binding })).toEqual({ provisioned: true });
    expect(db.query("SELECT name FROM sqlite_master WHERE name IN ('projects', 'sources', 'node_command_outbox')").all()).toEqual([]);
    await expect(node.provision({ ...provision, binding: { ...binding, cwd: "/wrong" } })).rejects.toThrow("binding mismatch");
    await expect(node.prompt({ binding, sessionId: "s", clientId: "missing-image", content: [
      { type: "image", attachmentId: "missing", mimeType: "image/png", byteSize: 1 },
    ], sourceSessionId: null })).rejects.toMatchObject({ error: { code: "invalid_request", retryable: false } });
    detach();
    await expect(node.prompt({ binding, sessionId: "s", clientId: "unlinked-image", content: [
      { type: "image", attachmentId: "missing", mimeType: "image/png", byteSize: 1 },
    ], sourceSessionId: null })).rejects.toMatchObject({ error: {
      code: "unavailable", message: "Attachment fetch failed: Server connection unavailable", retryable: true } });
    node.attach(recorder);
    const input = { sessionId: "s", clientId: "c", content: [{ type: "text" as const, text: "hello" }], sourceSessionId: null };
    expect(await node.prompt({ ...input, binding }))
      .toEqual({ inputId: "c" });
    // A replay (its reply lost) is recognized by Pi's durable input ID, not re-admitted.
    expect(await node.prompt({ ...input, binding })).toEqual({ inputId: "c" });
    const runtime = await runtimes(node).open("s", binding);
    expect(await runtimes(node).open("s", binding)).toBe(runtime);
    await runtime.waitForIdle();
    expect((await runtime.getMessages()).map(message => message.role)).toEqual(["user", "assistant"]);
    // A steer whose reply was lost is replayed: Pi finds it and admits it once.
    const interrupted = { sessionId: "s", clientId: "interrupted", content: [{ type: "text" as const, text: "unacknowledged" }], sourceSessionId: null };
    expect(await node.steer({ ...interrupted, binding })).toEqual({ inputId: "interrupted" });
    expect(await node.steer({ ...interrupted, binding })).toEqual({ inputId: "interrupted" });
    await runtime.waitForIdle();
    expect((await runtime.getMessages()).filter(message => message.role === "user" && JSON.stringify(message.content).includes("unacknowledged"))).toHaveLength(1);
    expect(events).toContain("agent_end");
    for (let i = 0; i < 100 && db.query("SELECT 1 FROM session_outbox").get(); i++) await Bun.sleep(5);
    expect(reports.some(report => report.startsWith("started:"))).toBe(true);
    expect(reports.at(-1)).toMatch(/^settled:.*:completed$/);
    expect(seqs).toEqual(seqs.map((_, index) => index + 1));
    await runtimes(node).close("s");
    await node.shutdown();

    const restarted = startNode(db);
    const delivered = events.length;
    const reported = reports.length;
    const steer = { sessionId: "s", clientId: "d", content: [{ type: "text" as const, text: "again" }], sourceSessionId: null };
    // Opening needs no server call: the node reopens Pi from its own storage. The run needs the
    // server's credentials, but nothing else is delivered: events are dropped and reports stay pending.
    restarted.attach(credentialsOnly);
    expect(await restarted.steer({ ...steer, binding }))
      .toEqual({ inputId: "d" });
    const reopened = await runtimes(restarted).open("s", binding);
    await reopened.waitForIdle();
    expect((await reopened.getMessages()).map(message => message.role)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"]);
    expect(events.length).toBe(delivered);
    // Lifecycle reports and commits stay pending, in order, until a connection attaches.
    expect(reports.length).toBe(reported);
    const pending = db.query<{ kind: string }, []>("SELECT kind FROM session_outbox ORDER BY id").all().map(row => row.kind);
    expect(pending.indexOf("started")).toBeGreaterThan(pending.indexOf("committed"));
    expect(pending.at(-1)).toBe("settled");
    restarted.attach(recorder);
    for (let i = 0; i < 100 && db.query("SELECT 1 FROM session_outbox").get(); i++) await Bun.sleep(5);
    expect(reports.slice(reported).map(report => report.split(":")[0])).toEqual(pending);
    await expect(restarted.abort({ binding: { ...binding, cwd: "/other" }, sessionId: "s" })).rejects.toThrow("binding mismatch");
    await runtimes(restarted).close("s");
    await restarted.shutdown();
  } finally { unregisterPiProvider(provider.provider.id); db.close(); }
});

test("a detached node keeps serving cached credentials to runs and fails clearly on a credential it never read", async () => {
  const db = openNodeDb(":memory:");
  const keys: Array<string | undefined> = [];
  const reply: FauxResponseFactory = (_context, options) => { keys.push(options?.apiKey); return fauxAssistantMessage("ok"); };
  const registered: string[] = [];
  const register = (id: string) => {
    const faux = fauxProvider({ provider: id, models: [{ id: "fake", contextWindow: 200_000, maxTokens: 1_000 }] });
    faux.setResponses([reply, reply]);
    // Requires a stored API key: no ambient fallback.
    registerPiProvider({ ...faux.provider, auth: { apiKey: { name: "Test key",
      resolve: async ({ credential }) => credential?.key ? { auth: { apiKey: credential.key } } : undefined } } });
    registered.push(id);
    return id;
  };
  const reads: string[] = [];
  const node = startNode(db);
  const binding = { sourceId: 7, cwd: "/tmp/reins-node-credentials", createdAt: "2026-01-01T00:00:00.000Z", parentSessionId: null };
  const start = async (provider: string) => {
    await node.provision({ ...provisionOf(provider, { model: { provider, modelId: "fake" }, thinkingLevel: null, task: null }), binding });
  };
  const prompt = async (sessionId: string, clientId: string) => {
    await node.prompt({ binding, sessionId, clientId, content: [{ type: "text", text: "go" }], sourceSessionId: null });
    const runtime = await runtimes(node).open(sessionId, binding);
    await runtime.waitForIdle();
    return (await runtime.getMessages()).at(-1);
  };
  try {
    const cached = register("node-cred-cached");
    const detach = node.attach({ ...credentialsOnly, getCredential: async (providerId: string) => { reads.push(providerId); return { type: "api_key" as const, key: `sk-${providerId}` }; } });
    await start(cached);
    expect(await prompt(cached, "a")).toMatchObject({ role: "assistant", stopReason: "stop" });
    expect(reads).toContain(cached);
    const before = reads.length;
    detach();
    // The link dropped: the run keeps using the credential it already read, with no server call.
    expect(await prompt(cached, "b")).toMatchObject({ role: "assistant", stopReason: "stop" });
    expect(keys).toEqual([`sk-${cached}`, `sk-${cached}`]);
    expect(reads.length).toBe(before);
    // A credential never read cannot be fetched while detached.
    const uncached = register("node-cred-uncached");
    await start(uncached);
    const errors = spyOn(console, "error").mockImplementation(() => {});
    const failed = await prompt(uncached, "c").finally(() => errors.mockRestore());
    expect(failed).toMatchObject({ role: "assistant", stopReason: "error" });
    expect(JSON.stringify(failed)).toContain("Credentials unavailable: no Reins server connection");
    expect(reads.length).toBe(before);
    for (const sessionId of registered) await runtimes(node).close(sessionId);
  } finally { await node.shutdown(); for (const id of registered) unregisterPiProvider(id); db.close(); }
});

function childNode(db: Database, providerName: string, responses: string[]) {
  const provider = fauxProvider({ provider: providerName, models: [{ id: "fake", contextWindow: 200_000, maxTokens: 1_000 }] });
  provider.setResponses(responses.map(text => fauxAssistantMessage(text)));
  registerPiProvider(provider.provider);
  const node = startNode(db);
  const received: Array<{ kind: string; startSeq?: number; settled?: SessionSettled; runId?: string }> = [];
  node.attach({
    committed: async ({ startSeq }) => { received.push({ kind: "committed", startSeq }); }, fetchAttachment: async () => null, event: () => {},
    started: async ({ runId }) => { received.push({ kind: "started", runId }); },
    settled: async settled => { received.push({ kind: "settled", settled }); }, ...noTools,
  });
  const binding = { sourceId: 7, cwd: "/tmp/reins-node-child", createdAt: "2026-01-01T00:00:00.000Z", parentSessionId: "parent" };
  const cleanup = async () => { await node.shutdown(); unregisterPiProvider(provider.provider.id); db.close(); };
  const provision = provisionOf("child", { model: { provider: provider.provider.id, modelId: "fake" }, thinkingLevel: null, task: null });
  return { node, binding, received, provider, provision, cleanup };
}

test("a child session's durable settlement carries its model and final reply after the run's commits, before the next run starts", async () => {
  const { node, binding, received, provider, provision, cleanup } = childNode(openNodeDb(":memory:"), "node-child-faux", ["child answer", "second answer"]);
  try {
    await node.provision({ ...provision, binding });
    await node.prompt({ binding, sessionId: "child", clientId: "c", content: [{ type: "text", text: "go" }], sourceSessionId: null });
    const runtime = await runtimes(node).open("child", binding);
    await runtime.waitForIdle();
    for (let i = 0; i < 100 && !received.some(input => input.kind === "settled"); i++) await Bun.sleep(5);
    await node.prompt({ binding, sessionId: "child", clientId: "d", content: [{ type: "text", text: "again" }], sourceSessionId: null });
    await runtime.waitForIdle();
    for (let i = 0; i < 100 && received.filter(input => input.kind === "settled").length < 2; i++) await Bun.sleep(5);
    const settled = received.filter(input => input.kind === "settled");
    expect(settled.map(input => input.settled)).toMatchObject([
      { status: "completed", metadata: { model: { provider: provider.provider.id, modelId: "fake" } }, reply: { text: "child answer", stopReason: "stop", errorMessage: null } },
      { status: "completed", reply: { text: "second answer" } },
    ]);
    const kinds = received.map(input => input.kind);
    const [firstSettled, secondSettled] = [kinds.indexOf("settled"), kinds.lastIndexOf("settled")];
    const secondStarted = kinds.indexOf("started", firstSettled);
    // Every commit of run 1 precedes its settlement; run 2 starts only after run 1 settled.
    expect(kinds.slice(0, firstSettled)).toContain("committed");
    expect(secondStarted).toBeGreaterThan(firstSettled);
    expect(kinds.slice(secondStarted, secondSettled)).toContain("committed");
    expect(received[secondStarted]!.runId).toBe(settled[1]!.settled!.runId);
    expect(received.find(input => input.kind === "started")).toEqual({ kind: "started", runId: settled[0]!.settled!.runId });
    await runtimes(node).close("child");
  } finally { await cleanup(); }
});

test("a child whose final reply cannot be read settles with replyError instead of a reply", async () => {
  const { node, binding, received, provision, cleanup } = childNode(openNodeDb(":memory:"), "node-child-reply-faux", ["unread answer"]);
  const errors = spyOn(console, "error").mockImplementation(() => {});
  try {
    await node.provision({ ...provision, binding });
    const runtime = await runtimes(node).open("child", binding);
    runtime.getMessages = async () => { throw new Error("transcript unavailable"); };
    await node.prompt({ binding, sessionId: "child", clientId: "c", content: [{ type: "text", text: "go" }], sourceSessionId: null });
    await runtime.waitForIdle();
    for (let i = 0; i < 100 && !received.some(input => input.kind === "settled"); i++) await Bun.sleep(5);
    expect(received.find(input => input.kind === "settled")?.settled).toMatchObject({ status: "completed", reply: null, replyError: "transcript unavailable" });
    await runtimes(node).close("child");
  } finally { errors.mockRestore(); await cleanup(); }
});

test("Reins tools run on the node and call the attached server for the calling session only, once each", async () => {
  const db = openNodeDb(":memory:");
  const provider = fauxProvider({ provider: "node-tools-faux", models: [{ id: "fake", contextWindow: 200_000, maxTokens: 1_000 }] });
  provider.setResponses([
    fauxAssistantMessage([
      fauxToolCall("execute", { code: "return 1" }, { id: "exec" }),
      fauxToolCall("search", { query: "tasks" }, { id: "search" }),
      fauxToolCall("create_task", { title: "T", description: "D", prompt: "Go" }, { id: "task" }),
    ], { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
    fauxAssistantMessage([fauxToolCall("execute", { code: "return 2" }, { id: "offline" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("offline done"),
  ]);
  registerPiProvider(provider.provider);
  const calls: unknown[] = [];
  const node = startNode(db);
  const detach = node.attach({
    ...serverCredentials, committed: async () => {}, fetchAttachment: async () => null, storeAttachment: noTools.storeAttachment, event: () => {}, started: async () => {}, settled: async () => {},
    executeScript: async input => { calls.push(["execute", input]); return { ok: true, text: "1" }; },
    searchScript: async input => { calls.push(["search", input]); throw new RpcFailure(APPLICATION_ERROR, "Node session unavailable: s"); },
    createTask: async input => { calls.push(["createTask", input]); throw new RpcFailure("unavailable", "Call timed out after 60000ms; outcome unknown", "unknown"); },
  });
  const binding = { sourceId: 7, cwd: "/tmp/reins-node-tools", createdAt: "2026-01-01T00:00:00.000Z", parentSessionId: null };
  const results = async () => Object.fromEntries((await runtime.getMessages()).filter(message => message.role === "toolResult")
    .map(message => [message.toolCallId, (message.content ?? []).map(block => block.type === "text" ? block.text : "").join("")]));
  let runtime!: Awaited<ReturnType<ReturnType<typeof runtimes>["open"]>>;
  try {
    await node.provision({ ...provisionOf("s", { model: { provider: provider.provider.id, modelId: "fake" }, thinkingLevel: null, task: null }), binding });
    await node.prompt({ binding, sessionId: "s", clientId: "a", content: [{ type: "text", text: "go" }], sourceSessionId: null });
    runtime = await runtimes(node).open("s", binding);
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
    detach();
    // The run still needs the server's credentials; the tool call cannot reach the server.
    node.attach(credentialsOnly);
    await node.prompt({ binding, sessionId: "s", clientId: "b", content: [{ type: "text", text: "again" }], sourceSessionId: null });
    await runtime.waitForIdle();
    expect((await results()).offline).toBe("Error: Reins server connection unavailable. The script did not run.");
    expect(calls).toHaveLength(3);
    await runtimes(node).close("s");
  } finally { await node.shutdown(); unregisterPiProvider(provider.provider.id); db.close(); }
});

test("tool-result images are referenced offline under node IDs, uploaded before the commits that reference them; providers get the bytes", async () => {
  const db = openNodeDb(":memory:");
  const dir = mkdtempSync(join(tmpdir(), "reins-node-image-"));
  // 1x1 PNGs of different colours.
  const pngs = ["iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="];
  pngs.forEach((png, index) => writeFileSync(join(dir, `${index}.png`), Buffer.from(png, "base64")));
  const provider = fauxProvider({ provider: "node-tool-images-faux", models: [{ id: "fake", input: ["text", "image"], contextWindow: 200_000, maxTokens: 1_000 }] });
  const contexts: string[] = [];
  const seen = (index: number): FauxResponseFactory => context => { contexts.push(JSON.stringify(context.messages)); return fauxAssistantMessage(`seen ${index}`); };
  provider.setResponses([0, 1].flatMap(index => [
    fauxAssistantMessage([fauxToolCall("read", { path: `${index}.png` }, { id: `read-${index}` })], { stopReason: "toolUse" }),
    seen(index),
  ]));
  registerPiProvider(provider.provider);
  const calls: Array<{ kind: "store"; attachmentId: string; data: Uint8Array } | { kind: "commit"; writesJson: string }> = [];
  const received: SessionEventReport[] = [];
  const node = startNode(db);
  const binding = { sourceId: 7, cwd: dir, createdAt: "2026-01-01T00:00:00.000Z", parentSessionId: null };
  const errors = spyOn(console, "error");
  const toolResult = async (id: string) => (await runtime.getMessages()).find(message => message.role === "toolResult" && message.toolCallId === id)!;
  const imageOf = async (id: string) => {
    const block = (await toolResult(id)).content!.find(item => item.type === "image");
    if (!block || !("attachmentId" in block) || typeof block.attachmentId !== "string") throw new Error(`No image reference in ${id}`);
    return block.attachmentId;
  };
  const drained = async () => { for (let i = 0; i < 100 && db.query("SELECT 1 FROM session_outbox").get(); i++) await Bun.sleep(5); };
  const run = async (clientId: string) => {
    const from = received.length;
    await node.prompt({ binding, sessionId: "s", clientId, content: [{ type: "text", text: "look" }], sourceSessionId: null });
    await runtime.waitForIdle();
    return received.slice(from).map(({ event }): unknown => JSON.parse(event));
  };
  let runtime!: Awaited<ReturnType<ReturnType<typeof runtimes>["open"]>>;
  try {
    await node.provision({ ...provisionOf("s", { model: { provider: provider.provider.id, modelId: "fake" }, thinkingLevel: null, task: null }), binding });
    runtime = await runtimes(node).open("s", binding);
    // The hook needs no server: this connection serves the run's credentials and delivers nothing.
    node.attach(credentialsOnly);
    await run("a");
    const first = await imageOf("read-0");
    const bytes = Buffer.from(pngs[0]!, "base64");
    expect(first).toMatch(/^att_[0-9a-f-]{36}$/);
    expect((await toolResult("read-0")).content!.find(block => block.type === "image")).toEqual({
      type: "image", attachmentId: first, mimeType: "image/png", byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    expect(db.query("SELECT data FROM node_attachments WHERE session_id = 's' AND attachment_id = ?").get(first)).toEqual({ data: bytes });
    // The provider still sees the image, hydrated from the node cache.
    expect(contexts[0]).toContain(pngs[0]);
    // The upload row precedes every commit row that mentions the reference; no row carries the bytes.
    const rows = db.query<{ id: number; kind: string; payload: string }, []>("SELECT id, kind, payload FROM session_outbox ORDER BY id").all();
    const upload = rows.find(row => row.kind === "attachment" && row.payload.includes(first))!;
    const referencing = rows.filter(row => row.kind === "committed" && row.payload.includes(first));
    expect(referencing.length).toBeGreaterThan(0);
    expect(referencing.every(row => row.id > upload.id)).toBe(true);
    expect(rows.every(row => !row.payload.includes(pngs[0]!.slice(0, 40)))).toBe(true);

    // Attaching delivers the upload (with the node's ID and the cached bytes) before those commits.
    node.attach({
      ...noReports, fetchAttachment: async () => null,
      storeAttachment: async ({ sessionId, attachmentId, data }) => { expect(sessionId).toBe("s"); calls.push({ kind: "store", attachmentId, data }); },
      committed: async ({ writesJson }) => { calls.push({ kind: "commit", writesJson }); },
      event: report => { received.push(report); },
    });
    await drained();
    const firstStore = calls.findIndex(call => call.kind === "store" && call.attachmentId === first);
    const stored = calls[firstStore];
    expect(stored?.kind === "store" && Buffer.from(stored.data)).toEqual(bytes);
    expect(calls.findIndex(call => call.kind === "commit" && call.writesJson.includes(first))).toBeGreaterThan(firstStore);

    // Connected, live events carry the node's reference, never the bytes.
    const second = await run("b");
    await drained();
    const reference = await imageOf("read-1");
    const images = second.flatMap(event => contentImages(event));
    expect(images.length).toBeGreaterThan(2); // tool_execution_end, message_start/end, entry_added, turn_end, agent_end
    expect(images.every(block => block.attachmentId === reference && block.data === undefined)).toBe(true);
    expect(received.every(({ event }) => !event.includes(pngs[1]!.slice(0, 40)))).toBe(true);
    expect(calls.findIndex(call => call.kind === "commit" && call.writesJson.includes(reference)))
      .toBeGreaterThan(calls.findIndex(call => call.kind === "store" && call.attachmentId === reference));
    expect(contexts[1]).toContain(pngs[1]);
    expect(calls.every(call => call.kind === "store" || !call.writesJson.includes(pngs[1]!.slice(0, 40)))).toBe(true);
    expect(errors).not.toHaveBeenCalled();
    await runtimes(node).close("s");
  } finally { errors.mockRestore(); await node.shutdown(); unregisterPiProvider(provider.provider.id); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("opening a task session checks out its provisioned branch on the node before building Pi, with no server attached", async () => {
  const db = openNodeDb(":memory:");
  const repo = mkdtempSync(join(tmpdir(), "reins-node-checkout-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  git("branch", "task/feature");
  const node = startNode(db);
  const binding = { sourceId: 7, cwd: repo, createdAt: "2026-01-01T00:00:00.000Z", parentSessionId: null };
  const checkouts = () => git("reflog").split("\n").filter(line => line.includes("checkout:")).length;
  try {
    // No model stops the open right after checkout, so no Pi provider is needed.
    await node.provision({ ...provisionOf("s", { model: null, thinkingLevel: null,
      task: { title: "Feature", description: null, branchName: "task/feature" } }), binding });
    await expect(runtimes(node).open("s", binding)).rejects.toThrow(NO_MODEL);
    expect(git("rev-parse", "--abbrev-ref", "HEAD")).toBe("task/feature");
    const before = checkouts();
    await expect(runtimes(node).open("s", binding)).rejects.toThrow(NO_MODEL);
    expect(checkouts()).toBe(before); // Already on the branch: no checkout.

    await node.provision({ ...provisionOf("gone", { model: null, thinkingLevel: null, task: { title: "Gone", description: null, branchName: "task/missing" } }), binding });
    await expect(runtimes(node).open("gone", binding)).rejects.toThrow(/git checkout failed \(exit 1\):.*task\/missing/);
    expect(git("rev-parse", "--abbrev-ref", "HEAD")).toBe("task/feature");
    expect(runtimes(node).has("gone")).toBe(false);
  } finally { await node.shutdown(); db.close(); rmSync(repo, { recursive: true, force: true }); }
});

test("the provisioned model lives in Pi's lane: open needs no server, setModel persists through Pi and reopen uses Pi's stored values", async () => {
  const db = openNodeDb(":memory:");
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
  const binding = { sourceId: 7, cwd: repo, createdAt: "2026-01-01T00:00:00.000Z", parentSessionId: null };
  const task = { title: "Frozen task", description: "From the snapshot", branchName: "task/frozen" };
  const laneConfig = (sessionId: string) => db.query<{ seq: number; value_json: string }, [string]>(
    "SELECT seq, value_json FROM pi_values WHERE session_id = ? AND namespace = 'pi.lane.config'").get(sessionId);
  const setModel = (modelId: string, thinkingLevel?: string) => ({ sessionId: "s", provider: provider.provider.id, modelId, ...(thinkingLevel ? { thinkingLevel } : {}) });
  let node = startNode(db);
  try {
    // Only credentials cross: no configuration, commit or report is delivered to a server in this test.
    node.attach(credentialsOnly);
    const provision = provisionOf("s", { model: { provider: provider.provider.id, modelId: "fake" }, thinkingLevel: "high", task });
    expect(await node.provision({ ...provision, binding })).toEqual({ provisioned: true });
    expect(JSON.parse(laneConfig("s")!.value_json)).toMatchObject({ model: { provider: provider.provider.id, modelId: "fake" }, thinkingLevel: "high" });
    // The configuration is not part of the binding.
    expect(nodeSessionBinding(db, "s")).toEqual(binding);

    expect(await node.prompt({ binding, sessionId: "s", clientId: "a", content: [{ type: "text", text: "go" }], sourceSessionId: null }))
      .toEqual({ inputId: "a" });
    let runtime = await runtimes(node).open("s", binding);
    await runtime.waitForIdle();
    expect(git("rev-parse", "--abbrev-ref", "HEAD")).toBe("task/frozen");
    expect(runtime.getSessionMetadata()).toEqual({ model: { provider: provider.provider.id, modelId: "fake" }, thinkingLevel: "high" });
    expect(seen[0]?.model).toBe("fake");
    expect(seen[0]?.systemPrompt).toContain("Frozen task");
    expect(seen[0]?.systemPrompt).toContain("From the snapshot");

    // Applied to the open runtime and persisted in Pi's lane; a replay applies the same absolute selection.
    expect(await node.setModel({ ...setModel("other", "low"), binding })).toEqual({ modelSet: true });
    expect(runtime.getSessionMetadata()).toEqual({ model: { provider: provider.provider.id, modelId: "other" }, thinkingLevel: "low" });
    const applied = laneConfig("s");
    expect(JSON.parse(applied!.value_json)).toMatchObject({ model: { modelId: "other" }, thinkingLevel: "low" });
    expect(await node.setModel({ ...setModel("other", "low"), binding })).toEqual({ modelSet: true });
    expect(JSON.parse(laneConfig("s")!.value_json)).toEqual(JSON.parse(applied!.value_json));
    expect(runtime.getSessionMetadata()).toEqual({ model: { provider: provider.provider.id, modelId: "other" }, thinkingLevel: "low" });

    // An unknown model is an explicit rejection, without a lane change.
    await expect(node.setModel({ ...setModel("missing"), binding })).rejects.toMatchObject({ error: {
      code: "invalid_request", message: `Model not found: ${provider.provider.id}/missing`, retryable: false } });
    expect(JSON.parse(laneConfig("s")!.value_json)).toEqual(JSON.parse(applied!.value_json));

    // Applied while the runtime is closed: a restarted node reopens with Pi's stored selection.
    await runtimes(node).close("s");
    expect(await node.setModel({ ...setModel("fake"), binding })).toEqual({ modelSet: true });
    await runtimes(node).close("s");
    await node.shutdown();
    node = startNode(db);
    node.attach(credentialsOnly);
    runtime = await runtimes(node).open("s", binding);
    // No thinking level in the command keeps Pi's current one.
    expect(runtime.getSessionMetadata()).toEqual({ model: { provider: provider.provider.id, modelId: "fake" }, thinkingLevel: "low" });
    await node.prompt({ binding, sessionId: "s", clientId: "b", content: [{ type: "text", text: "again" }], sourceSessionId: null });
    await runtime.waitForIdle();
    expect(seen.map(entry => entry.model)).toEqual(["fake", "fake"]);
    await runtimes(node).close("s");

    // A lane whose stored model is gone cannot open, but setModel repairs it.
    const removed = fauxProvider({ provider: "node-model-removed-faux", models: [{ id: "gone" }] });
    registerPiProvider(removed.provider);
    await node.provision({ ...provisionOf("stale", { model: { provider: removed.provider.id, modelId: "gone" }, thinkingLevel: null, task: null }), binding });
    unregisterPiProvider(removed.provider.id);
    await expect(runtimes(node).open("stale", binding)).rejects.toBeInstanceOf(NodeModelNotFoundError);
    expect(await node.setModel({ binding, ...setModel("fake"), sessionId: "stale" })).toEqual({ modelSet: true });
    expect((await runtimes(node).open("stale", binding)).getSessionMetadata().model).toEqual({ provider: provider.provider.id, modelId: "fake" });
    await runtimes(node).close("stale");
  } finally { await node.shutdown(); unregisterPiProvider(provider.provider.id); db.close(); rmSync(repo, { recursive: true, force: true }); }
});

test("after a node restart (a new process on the same storage, no memory), replays of provision, prompt, steer and setModel converge without a duplicate effect", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reins-node-restart-"));
  const provider = fauxProvider({ provider: "node-restart-faux", models: [{ id: "fake" }, { id: "other" }] });
  const replies: string[] = [];
  const reply = (text: string): FauxResponseFactory => () => { replies.push(text); return fauxAssistantMessage(text); };
  provider.setResponses([reply("one"), reply("two")]);
  registerPiProvider(provider.provider);
  const path = join(dir, "storage.db");
  const binding = { sourceId: 7, cwd: dir, createdAt: "2026-01-01T00:00:00.000Z", parentSessionId: null };
  const provision = provisionOf("s", { model: { provider: provider.provider.id, modelId: "fake" }, thinkingLevel: null, task: null });
  const prompt = { sessionId: "s", clientId: "p1", content: [{ type: "text" as const, text: "go" }], sourceSessionId: null };
  const steer = { sessionId: "s", clientId: "s1", content: [{ type: "text" as const, text: "and then" }], sourceSessionId: null };
  const setModel = { sessionId: "s", provider: provider.provider.id, modelId: "other", thinkingLevel: "low" };
  const state = (db: Database) => ({
    entries: db.query<{ seq: number; harness_id: string; role: string }, []>("SELECT seq, harness_id, role FROM session_messages WHERE session_id = 's' ORDER BY seq").all(),
    lane: db.query<{ value_json: string }, []>("SELECT value_json FROM pi_values WHERE session_id = 's' AND namespace = 'pi.lane.config'").get()?.value_json,
    binding: nodeSessionBinding(db, "s"),
  });
  let db = openNodeDb(path);
  let node = startNode(db);
  try {
    node.attach(credentialsOnly);
    expect(await node.provision({ ...provision, binding })).toEqual({ provisioned: true });
    expect(await node.prompt({ ...prompt, binding })).toEqual({ inputId: "p1" });
    await (await runtimes(node).open("s", binding)).waitForIdle();
    expect(await node.steer({ ...steer, binding })).toEqual({ inputId: "s1" });
    await (await runtimes(node).open("s", binding)).waitForIdle();
    expect(await node.setModel({ ...setModel, binding })).toEqual({ modelSet: true });
    const before = state(db);
    expect(before.entries.map(row => row.role)).toEqual(["reinsInput", "assistant", "reinsInput", "assistant"]);
    expect(replies).toEqual(["one", "two"]);

    // Every reply was lost; the node process restarts on the same storage and the server replays all four.
    await node.shutdown();
    db.close();
    db = openNodeDb(path);
    node = startNode(db);
    node.attach(credentialsOnly);
    expect(await node.provision({ ...provision, binding })).toEqual({ provisioned: true });
    expect(await node.prompt({ ...prompt, binding })).toEqual({ inputId: "p1" });
    expect(await node.steer({ ...steer, binding })).toEqual({ inputId: "s1" });
    expect(await node.setModel({ ...setModel, binding })).toEqual({ modelSet: true });
    await (await runtimes(node).open("s", binding)).waitForIdle();
    // No second input, run or model write: the replays converged on the stored state.
    const after = state(db);
    expect(after.entries).toEqual(before.entries);
    expect(JSON.parse(after.lane!)).toEqual(JSON.parse(before.lane!));
    expect(after.binding).toEqual(binding);
    expect(replies).toEqual(["one", "two"]);
  } finally {
    await node.shutdown();
    db.close();
    unregisterPiProvider(provider.provider.id);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a hydrate is refused as busy while a run is active; shutdown aborts the run, closes every runtime and refuses later commands", async () => {
  const db = openNodeDb(":memory:");
  const provider = fauxProvider({ provider: "node-shutdown-faux", models: [{ id: "fake", contextWindow: 200_000, maxTokens: 1_000 }] });
  const reached = Promise.withResolvers<void>();
  provider.setResponses([(_context, options) => new Promise(resolve => {
    reached.resolve();
    // Never answers on its own: only an abort ends the run.
    options?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("", { stopReason: "aborted" })));
  })]);
  registerPiProvider(provider.provider);
  const node = startNode(db);
  const settled: SessionSettled[] = [];
  node.attach({ ...noReports, committed: async () => {}, fetchAttachment: async () => null, event: () => {}, settled: async report => { settled.push(report); } });
  const binding = { sourceId: 7, cwd: "/tmp/reins-node-shutdown", createdAt: "2026-01-01T00:00:00.000Z", parentSessionId: null };
  try {
    await node.provision({ ...provisionOf("s", { model: { provider: provider.provider.id, modelId: "fake" }, thinkingLevel: null, task: null }), binding });
    expect(await node.prompt({ sessionId: "s", binding, clientId: "a", content: [{ type: "text", text: "work" }], sourceSessionId: null })).toEqual({ inputId: "a" });
    const runtime = await runtimes(node).open("s", binding);
    await reached.promise;
    expect(runtime.isStreaming()).toBe(true);
    // Replacing the copy under an active run is refused, and the copy is kept.
    await expect(node.hydrate({ sessionId: "s", binding, task: null, snapshot: { harnessNextSeq: 1, rowCounts: { entries: 0, values: 0, lists: 0, usage: 0 }, digest: "0".repeat(64) } }))
      .rejects.toMatchObject({ error: { code: "busy", retryable: false } });
    expect(nodeSessionBinding(db, "s")).toEqual(binding);

    await node.shutdown();
    expect(runtime.isStreaming()).toBe(false);
    expect(runtimes(node).has("s")).toBe(false);
    for (let i = 0; i < 100 && settled.length === 0; i++) await Bun.sleep(5);
    expect(settled.map(report => report.status)).toEqual(["aborted"]);
    await expect(node.prompt({ sessionId: "s", binding, clientId: "b", content: [], sourceSessionId: null })).rejects.toThrow("Node stopped");
  } finally { await node.shutdown(); unregisterPiProvider(provider.provider.id); db.close(); }
});

test("delete drops everything the node holds for a session, aborting its run; later commands answer not_found and a repeat is a no-op", async () => {
  const db = openNodeDb(":memory:");
  const provider = fauxProvider({ provider: "node-delete-faux", models: [{ id: "fake", contextWindow: 200_000, maxTokens: 1_000 }] });
  const reached = Promise.withResolvers<void>();
  provider.setResponses([(_context, options) => new Promise(resolve => {
    reached.resolve();
    options?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("", { stopReason: "aborted" })));
  })]);
  registerPiProvider(provider.provider);
  const node = startNode(db);
  // Nothing is delivered: the session's reports stay in its outbox until the delete.
  node.attach({ ...credentialsOnly });
  const binding = { sourceId: 7, cwd: "/tmp/reins-node-delete", createdAt: "2026-01-01T00:00:00.000Z", parentSessionId: null };
  const held = (table: string) => db.query<{ n: number }, [string]>(`SELECT COUNT(*) n FROM ${table} WHERE ${table === "sessions" ? "id" : "session_id"} = ?`).get("s")!.n;
  try {
    await node.provision({ ...provisionOf("s", { model: { provider: provider.provider.id, modelId: "fake" }, thinkingLevel: null, task: null }), binding });
    await node.prompt({ sessionId: "s", binding, clientId: "a", content: [{ type: "text", text: "work" }], sourceSessionId: null });
    const runtime = await runtimes(node).open("s", binding);
    await reached.promise;
    expect(held("session_outbox")).toBeGreaterThan(0);

    expect(await node.delete({ sessionId: "s" })).toEqual({ deleted: true });
    expect(runtime.isStreaming()).toBe(false);
    expect(runtimes(node).has("s")).toBe(false);
    for (const table of ["sessions", "session_messages", "pi_values", "session_outbox", "node_attachments"]) expect({ table, n: held(table) }).toEqual({ table, n: 0 });
    await expect(node.prompt({ sessionId: "s", binding, clientId: "b", content: [], sourceSessionId: null }))
      .rejects.toMatchObject({ error: { code: "not_found" } });
    expect(await node.delete({ sessionId: "s" })).toEqual({ deleted: true });
  } finally { await node.shutdown(); unregisterPiProvider(provider.provider.id); db.close(); }
});

test("skills.list serves the skills of the source checkout it is given (name and description), not_found for a missing checkout", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "reins-node-skills-"));
  const db = openNodeDb(":memory:");
  const node = startNode(db);
  try {
    mkdirSync(join(cwd, ".agents", "skills", "review"), { recursive: true });
    writeFileSync(join(cwd, ".agents", "skills", "review", "SKILL.md"), "---\nname: review\ndescription: Reviews code\n---\n\nBody");
    const { skills } = await node.listSkills({ sourceId: 7, cwd });
    expect(skills.find(skill => skill.name === "review")).toEqual({ name: "review", description: "Reviews code" });
    await expect(node.listSkills({ sourceId: 7, cwd: join(cwd, "missing") })).rejects.toMatchObject({ error: { code: "not_found" } });
  } finally { await node.shutdown(); db.close(); rmSync(cwd, { recursive: true, force: true }); }
});

import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { APPLICATION_ERROR } from "./protocol/errors.js";
import { RpcFailure } from "./protocol/peer.js";
import { startNode } from "./node.js";
import { nodeAdmissionReceipt, nodeSessionBinding, setNodeDb } from "./storage.js";
import { registerPiProvider, unregisterPiProvider } from "./runtime/context.js";
import { NodeModelNotFoundError, type NodeRuntimePolicy } from "./runtime/build.js";
import type { SessionEventReport, SessionSettled, SessionStarted } from "./protocol/schema.js";
import type { SessionConfiguration } from "./contract.js";

const noTools = {
  executeScript: async () => { throw new Error("unexpected tool call"); },
  searchScript: async () => { throw new Error("unexpected tool call"); },
  createTask: async () => { throw new Error("unexpected tool call"); },
};
const noReports = { started: async () => {}, settled: async () => {}, ...noTools };
const scratch: SessionConfiguration = { model: null, thinkingLevel: null, task: null };
const provisionOf = (sessionId: string, configuration: SessionConfiguration = scratch) =>
  ({ op: "session.provision" as const, sessionId, sourceId: 7, configuration });
const NO_MODEL = "AgentHarness Pi runtime requires an explicit model";
const credentials: NodeRuntimePolicy["credentials"] = {
  read: async () => ({ type: "api_key", key: "test" }), list: async () => [],
  modify: async () => ({ type: "api_key", key: "test" }), delete: async () => {},
};

test("node selects its own storage when no database is passed by the host", async () => {
  const db = new Database(":memory:");
  setNodeDb(db);
  let node;
  try {
    node = startNode({ credentials });
    const binding = { sourceId: 7, cwd: "/tmp/node-owned", createdAt: "2026-01-01", parentSessionId: null };
    expect(await node.send(provisionOf("owned"), binding)).toMatchObject({ ok: true });
    expect(db.query("SELECT id, cwd FROM sessions WHERE id = 'owned'").get()).toEqual({ id: "owned", cwd: "/tmp/node-owned" });
  } finally { node?.stop(); setNodeDb(); db.close(); }
});

test("node startup fails synchronously on an unsupported database before admitting commands", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE old_node_data(id TEXT); INSERT INTO old_node_data VALUES ('keep')");
  setNodeDb(db);
  try {
    expect(() => startNode({ credentials })).toThrow(/unversioned/i);
    expect(db.query("SELECT id FROM old_node_data").all()).toEqual([{ id: "keep" }]);
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 0 });
  } finally { setNodeDb(); db.close(); }
});

test("a session missing from node storage rejects input without an ambiguous admission", async () => {
  const db = new Database(":memory:");
  setNodeDb(db);
  const node = startNode({ credentials });
  const binding = { sourceId: 7, cwd: "/tmp/reins-node-owner", createdAt: "2026-01-01T00:00:00.000Z", parentSessionId: null };
  try {
    expect(await node.send({ op: "session.prompt", sessionId: "lost", clientId: "input", content: [{ type: "text", text: "hello" }] }, binding, "command"))
      .toEqual({ ok: false, error: { code: "not_found", message: "This session's node data is missing. Start a new session.", retryable: false } });
    expect(nodeAdmissionReceipt(db, "command")).toBeNull();
    await expect(node.open("lost", binding)).rejects.toThrow("This session's node data is missing. Start a new session.");
    expect(await node.send({ op: "session.resumePending", sessionId: "lost" }, binding))
      .toMatchObject({ ok: false, error: { code: "not_found", retryable: false } });
  } finally { node.stop(); setNodeDb(); db.close(); }
});

test("opening a session does not fetch attachments from past inputs", async () => {
  const db = new Database(":memory:");
  setNodeDb(db);
  const node = startNode({ credentials });
  node.attach({ committed: async () => {}, fetchAttachment: async () => { throw new Error("historical fetch"); }, event: () => {}, ...noReports });
  const binding = { sourceId: 7, cwd: "/tmp/reins-node-owner", createdAt: "2026-01-01T00:00:00.000Z", parentSessionId: null };
  try {
    await node.send(provisionOf("s"), binding);
    db.query(`INSERT INTO session_messages(session_id,seq,harness_id,role,message_json,created_at)
      VALUES(?,?,?,?,?,?)`).run("s", 1, "entry-1", "reinsInput", JSON.stringify({
        type: "message", message: { role: "reinsInput", content: [
          { type: "image", attachmentId: "old", mimeType: "image/png", byteSize: 1 },
        ] },
      }), binding.createdAt);
    // Scratch provision without a model: the open stops before Pi, after reading history.
    await expect(node.open("s", binding)).rejects.toThrow(NO_MODEL);
    expect(db.query("SELECT 1 FROM node_attachments").get()).toBeNull();
  } finally { node.stop(); setNodeDb(); db.close(); }
});

test("the newest attached server connection fetches attachments across handler reinstall", async () => {
  const db = new Database(":memory:");
  const bytes = Buffer.from("abc");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  setNodeDb(db);
  const base = { credentials };
  const first = startNode(base);
  const detachStale = first.attach({ committed: async () => {}, fetchAttachment: async () => null, event: () => {}, ...noReports });
  let fetches = 0;
  const reinstalled = startNode(base);
  reinstalled.attach({ committed: async () => {}, fetchAttachment: async () => {
    fetches++;
    return { data: bytes, mimeType: "image/png", byteSize: bytes.length, sha256 };
  }, event: () => {}, ...noReports });
  detachStale();
  const binding = { sourceId: 7, cwd: "/tmp/reins-node-owner", createdAt: "2026-01-01T00:00:00.000Z", parentSessionId: null };
  try {
    expect(await reinstalled.send(provisionOf("s"), binding)).toMatchObject({ ok: true });
    await expect(reinstalled.send({ op: "session.prompt", sessionId: "s", clientId: "image", content: [
      { type: "image", attachmentId: "new-image", mimeType: "image/png", byteSize: bytes.length },
    ] }, binding)).rejects.toThrow(NO_MODEL);
    expect(fetches).toBe(1);
    expect(db.query("SELECT data FROM node_attachments WHERE session_id = ? AND attachment_id = ?").get("s", "new-image"))
      .toEqual({ data: bytes });
  } finally { first.stop(); reinstalled.stop(); setNodeDb(); db.close(); }
});

test("provision has Pi create the lane before recording its receipt, so a replay after a crash in between converges", async () => {
  const db = new Database(":memory:");
  const provider = fauxProvider({ provider: "node-provision-faux", models: [{ id: "fake" }] });
  registerPiProvider(provider.provider);
  setNodeDb(db);
  const node = startNode({ credentials });
  const replicated: number[] = [];
  node.attach({ ...noReports, committed: async ({ startSeq }) => { replicated.push(startSeq); }, fetchAttachment: async () => null, event: () => {} });
  const binding = { sourceId: 7, cwd: "/tmp/reins-node-provision", createdAt: "2026-01-01T00:00:00.000Z", parentSessionId: null };
  const piState = (sessionId: string) => ({
    values: db.query("SELECT namespace, key, seq, value_json FROM pi_values WHERE session_id = ? ORDER BY namespace, key").all(sessionId),
    nextSeq: db.query("SELECT harness_next_seq FROM sessions WHERE id = ?").get(sessionId),
  });
  const provision = provisionOf("s", { model: { provider: provider.provider.id, modelId: "fake" }, thinkingLevel: "high", task: null });
  try {
    // A crash after Pi created the lane but before the receipt: the server sees no receipt and replays.
    db.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON admission_receipts BEGIN SELECT RAISE(ABORT, 'receipt unavailable'); END");
    await expect(node.send(provision, binding, "provision")).rejects.toThrow("receipt unavailable");
    db.exec("DROP TRIGGER reject_receipt");
    expect(nodeAdmissionReceipt(db, "provision")).toBeNull();
    const created = piState("s");
    expect(created.values.length).toBeGreaterThan(0);

    // The replay converges: the lane exists, so nothing is written again, and the receipt is recorded.
    expect(await node.send(provision, binding, "provision")).toEqual({ ok: true, value: { kind: "provisioned" } });
    expect(nodeAdmissionReceipt(db, "provision")?.payload).toBe(JSON.stringify(provision));
    expect(piState("s")).toEqual(created);
    // A replay of the receipted command is a no-op.
    expect(await node.send(provision, binding, "provision")).toEqual({ ok: true, value: { kind: "provisioned" } });
    expect(piState("s")).toEqual(created);
    // Pi's lane commit replicated to the server once, through the normal commit path.
    expect(replicated).toEqual([1]);
    // Pi's lane API reads the provisioned selection.
    expect((await node.open("s", binding)).getSessionMetadata()).toEqual({ model: { provider: provider.provider.id, modelId: "fake" }, thinkingLevel: "high" });
    await node.close("s");

    // No resolved model: no lane until session.setModel.
    expect(await node.send(provisionOf("scratch"), binding, "scratch")).toEqual({ ok: true, value: { kind: "provisioned" } });
    expect(piState("scratch").values).toEqual([]);
    await expect(node.open("scratch", binding)).rejects.toThrow(NO_MODEL);

    // A model the node's registry does not know is rejected before anything is stored.
    const unknown = provisionOf("unknown", { model: { provider: provider.provider.id, modelId: "missing" }, thinkingLevel: null, task: null });
    expect(await node.send(unknown, binding, "unknown")).toEqual({ ok: false, error: {
      code: "invalid_request", message: `Model not found: ${provider.provider.id}/missing`, retryable: false } });
    expect(nodeAdmissionReceipt(db, "unknown")).toBeNull();
    expect(nodeSessionBinding(db, "unknown")).toBeNull();
  } finally { node.stop(); unregisterPiProvider(provider.provider.id); setNodeDb(); db.close(); }
});

test("node provisions an immutable binding, executes Pi and reopens from canonical storage without product tables", async () => {
  const db = new Database(":memory:");
  const provider = fauxProvider({ provider: "node-owner-faux", models: [{ id: "fake", contextWindow: 200_000, maxTokens: 1_000 }] });
  provider.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("interrupted answer"), fauxAssistantMessage("second")]);
  registerPiProvider(provider.provider);
  const events: string[] = [];
  const seqs: number[] = [];
  const reports: string[] = [];
  const recorder = {
    committed: async () => { reports.push("committed"); }, fetchAttachment: async () => null,
    event: ({ seq, event }: SessionEventReport) => { seqs.push(seq); events.push(event.type); },
    started: async ({ runId }: SessionStarted) => { reports.push(`started:${runId}`); },
    settled: async ({ runId, status }: SessionSettled) => { reports.push(`settled:${runId}:${status}`); },
    ...noTools,
  };
  setNodeDb(db);
  const dependencies = { credentials: { ...credentials, list: async () => [{ providerId: provider.provider.id, type: "api_key" as const }] } };
  const binding = { sourceId: 7, cwd: "/tmp/reins-node-owner", createdAt: "2026-01-01T00:00:00.000Z", parentSessionId: null };
  const provision = provisionOf("s", { model: { provider: provider.provider.id, modelId: "fake" }, thinkingLevel: null, task: null });
  try {
    const node = startNode(dependencies);
    const detach = node.attach(recorder);
    expect(await node.send(provision, binding, "provision-command")).toEqual({ ok: true, value: { kind: "provisioned" } });
    expect(nodeAdmissionReceipt(db, "provision-command")).toEqual({ sessionId: "s", operation: "session.provision", payload: JSON.stringify(provision) });
    expect(await node.send(provision, binding, "provision-command")).toEqual({ ok: true, value: { kind: "provisioned" } });
    expect(db.query("SELECT name FROM sqlite_master WHERE name IN ('projects', 'sources', 'node_command_outbox')").all()).toEqual([]);
    await expect(node.send(provision, { ...binding, cwd: "/wrong" })).rejects.toThrow("binding mismatch");
    expect(await node.send({ op: "session.prompt", sessionId: "s", clientId: "missing-image", content: [
      { type: "image", attachmentId: "missing", mimeType: "image/png", byteSize: 1 },
    ] }, binding, "missing-image-command")).toMatchObject({ ok: false, error: { code: "invalid_request", retryable: false } });
    expect(nodeAdmissionReceipt(db, "missing-image-command")).toBeNull();
    detach();
    expect(await node.send({ op: "session.prompt", sessionId: "s", clientId: "unlinked-image", content: [
      { type: "image", attachmentId: "missing", mimeType: "image/png", byteSize: 1 },
    ] }, binding, "unlinked-image-command")).toEqual({ ok: false, error: {
      code: "unavailable", message: "Attachment fetch failed: Server connection unavailable", retryable: true } });
    expect(nodeAdmissionReceipt(db, "unlinked-image-command")).toBeNull();
    node.attach(recorder);
    const input = { op: "session.prompt" as const, sessionId: "s", clientId: "c", content: [{ type: "text" as const, text: "hello" }] };
    expect(await node.send(input, binding, "input-command"))
      .toEqual({ ok: true, value: { kind: "admitted", inputId: "c" } });
    expect(nodeAdmissionReceipt(db, "input-command")).toEqual({ sessionId: "s", operation: "session.prompt", payload: JSON.stringify(input) });
    expect(await node.send(input, binding, "input-command")).toEqual({ ok: true, value: { kind: "admitted", inputId: "c" } });
    const runtime = await node.open("s", binding);
    const reinstalled = startNode(dependencies); // Server handler reload keeps the node process/runtime owner.
    node.stop();
    expect(await reinstalled.open("s", binding)).toBe(runtime);
    await runtime.waitForIdle();
    expect((await runtime.getMessages()).map(message => message.role)).toEqual(["user", "assistant"]);
    db.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON admission_receipts BEGIN SELECT RAISE(ABORT, 'receipt unavailable'); END");
    const interrupted = { op: "session.steer" as const, sessionId: "s", clientId: "interrupted", content: [{ type: "text" as const, text: "unacknowledged" }] };
    await expect(reinstalled.send(interrupted, binding, "interrupted-command")).rejects.toThrow("receipt unavailable");
    expect(nodeAdmissionReceipt(db, "interrupted-command")).toBeNull();
    expect((await runtime.getMessages()).some(message => message.role === "user" && JSON.stringify(message.content).includes("unacknowledged"))).toBe(true);
    db.exec("DROP TRIGGER reject_receipt");
    await runtime.waitForIdle();
    expect(events).toContain("agent_end");
    for (let i = 0; i < 100 && db.query("SELECT 1 FROM session_outbox").get(); i++) await Bun.sleep(5);
    expect(reports.some(report => report.startsWith("started:"))).toBe(true);
    expect(reports.at(-1)).toMatch(/^settled:.*:completed$/);
    expect(seqs).toEqual(seqs.map((_, index) => index + 1));
    await reinstalled.close("s");
    reinstalled.stop();

    const restarted = startNode(dependencies);
    const delivered = events.length;
    const reported = reports.length;
    const steer = { op: "session.steer" as const, sessionId: "s", clientId: "d", content: [{ type: "text" as const, text: "again" }] };
    // Opening needs no server: with no connection attached the node reopens Pi from its own storage;
    // events are dropped and reports stay pending.
    expect(await restarted.send(steer, binding))
      .toEqual({ ok: true, value: { kind: "admitted", inputId: "d" } });
    const reopened = await restarted.open("s", binding);
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
    await expect(restarted.send({ op: "session.abort", sessionId: "s" }, { ...binding, cwd: "/other" })).rejects.toThrow("binding mismatch");
    await restarted.close("s");
    restarted.stop();
  } finally { unregisterPiProvider(provider.provider.id); setNodeDb(); db.close(); }
});

function childNode(db: Database, providerName: string, responses: string[]) {
  const provider = fauxProvider({ provider: providerName, models: [{ id: "fake", contextWindow: 200_000, maxTokens: 1_000 }] });
  provider.setResponses(responses.map(text => fauxAssistantMessage(text)));
  registerPiProvider(provider.provider);
  setNodeDb(db);
  const node = startNode({ credentials });
  const received: Array<{ kind: string; startSeq?: number; settled?: SessionSettled; runId?: string }> = [];
  node.attach({
    committed: async ({ startSeq }) => { received.push({ kind: "committed", startSeq }); }, fetchAttachment: async () => null, event: () => {},
    started: async ({ runId }) => { received.push({ kind: "started", runId }); },
    settled: async settled => { received.push({ kind: "settled", settled }); }, ...noTools,
  });
  const binding = { sourceId: 7, cwd: "/tmp/reins-node-child", createdAt: "2026-01-01T00:00:00.000Z", parentSessionId: "parent" };
  const cleanup = () => { node.stop(); unregisterPiProvider(provider.provider.id); setNodeDb(); db.close(); };
  const provision = provisionOf("child", { model: { provider: provider.provider.id, modelId: "fake" }, thinkingLevel: null, task: null });
  return { node, binding, received, provider, provision, cleanup };
}

test("a child session's durable settlement carries its model and final reply after the run's commits, before the next run starts", async () => {
  const { node, binding, received, provider, provision, cleanup } = childNode(new Database(":memory:"), "node-child-faux", ["child answer", "second answer"]);
  try {
    await node.send(provision, binding);
    await node.send({ op: "session.prompt", sessionId: "child", clientId: "c", content: [{ type: "text", text: "go" }] }, binding);
    const runtime = await node.open("child", binding);
    await runtime.waitForIdle();
    for (let i = 0; i < 100 && !received.some(input => input.kind === "settled"); i++) await Bun.sleep(5);
    await node.send({ op: "session.prompt", sessionId: "child", clientId: "d", content: [{ type: "text", text: "again" }] }, binding);
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
    await node.close("child");
  } finally { cleanup(); }
});

test("a child whose final reply cannot be read settles with replyError instead of a reply", async () => {
  const { node, binding, received, provision, cleanup } = childNode(new Database(":memory:"), "node-child-reply-faux", ["unread answer"]);
  const errors = spyOn(console, "error").mockImplementation(() => {});
  try {
    await node.send(provision, binding);
    const runtime = await node.open("child", binding);
    runtime.getMessages = async () => { throw new Error("transcript unavailable"); };
    await node.send({ op: "session.prompt", sessionId: "child", clientId: "c", content: [{ type: "text", text: "go" }] }, binding);
    await runtime.waitForIdle();
    for (let i = 0; i < 100 && !received.some(input => input.kind === "settled"); i++) await Bun.sleep(5);
    expect(received.find(input => input.kind === "settled")?.settled).toMatchObject({ status: "completed", reply: null, replyError: "transcript unavailable" });
    await node.close("child");
  } finally { errors.mockRestore(); cleanup(); }
});

test("Reins tools run on the node and call the attached server for the calling session only, once each", async () => {
  const db = new Database(":memory:");
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
  setNodeDb(db);
  const calls: unknown[] = [];
  const node = startNode({ credentials });
  const detach = node.attach({
    committed: async () => {}, fetchAttachment: async () => null, event: () => {}, started: async () => {}, settled: async () => {},
    executeScript: async input => { calls.push(["execute", input]); return { ok: true, text: "1" }; },
    searchScript: async input => { calls.push(["search", input]); throw new RpcFailure(APPLICATION_ERROR, "Node session unavailable: s"); },
    createTask: async input => { calls.push(["createTask", input]); throw new RpcFailure("unavailable", "Call timed out after 60000ms; outcome unknown", "unknown"); },
  });
  const binding = { sourceId: 7, cwd: "/tmp/reins-node-tools", createdAt: "2026-01-01T00:00:00.000Z", parentSessionId: null };
  const results = async () => Object.fromEntries((await runtime.getMessages()).filter(message => message.role === "toolResult")
    .map(message => [message.toolCallId, (message.content ?? []).map(block => block.type === "text" ? block.text : "").join("")]));
  let runtime!: Awaited<ReturnType<typeof node.open>>;
  try {
    await node.send(provisionOf("s", { model: { provider: provider.provider.id, modelId: "fake" }, thinkingLevel: null, task: null }), binding);
    await node.send({ op: "session.prompt", sessionId: "s", clientId: "a", content: [{ type: "text", text: "go" }] }, binding);
    runtime = await node.open("s", binding);
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
    await node.send({ op: "session.prompt", sessionId: "s", clientId: "b", content: [{ type: "text", text: "again" }] }, binding);
    await runtime.waitForIdle();
    expect((await results()).offline).toBe("Error: Reins server connection unavailable. The script did not run.");
    expect(calls).toHaveLength(3);
    await node.close("s");
  } finally { node.stop(); unregisterPiProvider(provider.provider.id); setNodeDb(); db.close(); }
});

test("opening a task session checks out its provisioned branch on the node before building Pi, with no server attached", async () => {
  const db = new Database(":memory:");
  const repo = mkdtempSync(join(tmpdir(), "reins-node-checkout-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  git("branch", "task/feature");
  setNodeDb(db);
  const node = startNode({ credentials });
  const binding = { sourceId: 7, cwd: repo, createdAt: "2026-01-01T00:00:00.000Z", parentSessionId: null };
  const checkouts = () => git("reflog").split("\n").filter(line => line.includes("checkout:")).length;
  try {
    // No model stops the open right after checkout, so no Pi provider is needed.
    await node.send(provisionOf("s", { model: null, thinkingLevel: null,
      task: { title: "Feature", description: null, branchName: "task/feature" } }), binding);
    await expect(node.open("s", binding)).rejects.toThrow(NO_MODEL);
    expect(git("rev-parse", "--abbrev-ref", "HEAD")).toBe("task/feature");
    const before = checkouts();
    await expect(node.open("s", binding)).rejects.toThrow(NO_MODEL);
    expect(checkouts()).toBe(before); // Already on the branch: no checkout.

    await node.send(provisionOf("gone", { model: null, thinkingLevel: null, task: { title: "Gone", description: null, branchName: "task/missing" } }), binding);
    await expect(node.open("gone", binding)).rejects.toThrow(/git checkout failed \(exit 1\):.*task\/missing/);
    expect(git("rev-parse", "--abbrev-ref", "HEAD")).toBe("task/feature");
    expect(node.hasRuntime("gone")).toBe(false);
  } finally { node.stop(); setNodeDb(); db.close(); rmSync(repo, { recursive: true, force: true }); }
});

test("the provisioned model lives in Pi's lane: open needs no server, setModel persists through Pi and reopen uses Pi's stored values", async () => {
  const db = new Database(":memory:");
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
  setNodeDb(db);
  const dependencies = { credentials: { ...credentials, list: async () => [{ providerId: provider.provider.id, type: "api_key" as const }] } };
  const binding = { sourceId: 7, cwd: repo, createdAt: "2026-01-01T00:00:00.000Z", parentSessionId: null };
  const task = { title: "Frozen task", description: "From the snapshot", branchName: "task/frozen" };
  const laneConfig = (sessionId: string) => db.query<{ seq: number; value_json: string }, [string]>(
    "SELECT seq, value_json FROM pi_values WHERE session_id = ? AND namespace = 'pi.lane.config'").get(sessionId);
  const setModel = (modelId: string, thinkingLevel?: string) => ({ op: "session.setModel" as const, sessionId: "s", provider: provider.provider.id, modelId, ...(thinkingLevel ? { thinkingLevel } : {}) });
  let node = startNode(dependencies);
  try {
    // No server connection is ever attached in this test.
    const provision = provisionOf("s", { model: { provider: provider.provider.id, modelId: "fake" }, thinkingLevel: "high", task });
    expect(await node.send(provision, binding, "provision")).toEqual({ ok: true, value: { kind: "provisioned" } });
    expect(nodeAdmissionReceipt(db, "provision")?.payload).toBe(JSON.stringify(provision));
    expect(JSON.parse(laneConfig("s")!.value_json)).toMatchObject({ model: { provider: provider.provider.id, modelId: "fake" }, thinkingLevel: "high" });
    // The configuration is not part of the binding.
    expect(nodeSessionBinding(db, "s")).toEqual(binding);

    expect(await node.send({ op: "session.prompt", sessionId: "s", clientId: "a", content: [{ type: "text", text: "go" }] }, binding))
      .toMatchObject({ ok: true });
    let runtime = await node.open("s", binding);
    await runtime.waitForIdle();
    expect(git("rev-parse", "--abbrev-ref", "HEAD")).toBe("task/frozen");
    expect(runtime.getSessionMetadata()).toEqual({ model: { provider: provider.provider.id, modelId: "fake" }, thinkingLevel: "high" });
    expect(seen[0]?.model).toBe("fake");
    expect(seen[0]?.systemPrompt).toContain("Frozen task");
    expect(seen[0]?.systemPrompt).toContain("From the snapshot");

    // Applied to the open runtime and persisted in Pi's lane; a replay by command ID applies nothing.
    expect(await node.send(setModel("other", "low"), binding, "model-1")).toEqual({ ok: true, value: { kind: "modelSet" } });
    expect(runtime.getSessionMetadata()).toEqual({ model: { provider: provider.provider.id, modelId: "other" }, thinkingLevel: "low" });
    const applied = laneConfig("s");
    expect(JSON.parse(applied!.value_json)).toMatchObject({ model: { modelId: "other" }, thinkingLevel: "low" });
    expect(await node.send(setModel("other", "low"), binding, "model-1")).toEqual({ ok: true, value: { kind: "modelSet" } });
    expect(laneConfig("s")).toEqual(applied);
    await expect(node.send(setModel("fake"), binding, "model-1")).rejects.toThrow("Node admission receipt mismatch: model-1");

    // An unknown model is an explicit rejection, without a receipt or a lane change.
    expect(await node.send(setModel("missing"), binding, "model-missing")).toEqual({ ok: false, error: {
      code: "invalid_request", message: `Model not found: ${provider.provider.id}/missing`, retryable: false } });
    expect(nodeAdmissionReceipt(db, "model-missing")).toBeNull();
    expect(laneConfig("s")).toEqual(applied);

    // Applied while the runtime is closed: a restarted node reopens with Pi's stored selection.
    await node.close("s");
    expect(await node.send(setModel("fake"), binding, "model-2")).toMatchObject({ ok: true });
    await node.close("s");
    node.stop();
    node = startNode(dependencies);
    runtime = await node.open("s", binding);
    // No thinking level in the command keeps Pi's current one.
    expect(runtime.getSessionMetadata()).toEqual({ model: { provider: provider.provider.id, modelId: "fake" }, thinkingLevel: "low" });
    await node.send({ op: "session.prompt", sessionId: "s", clientId: "b", content: [{ type: "text", text: "again" }] }, binding);
    await runtime.waitForIdle();
    expect(seen.map(entry => entry.model)).toEqual(["fake", "fake"]);
    await node.close("s");

    // A lane whose stored model is gone cannot open, but setModel repairs it.
    const removed = fauxProvider({ provider: "node-model-removed-faux", models: [{ id: "gone" }] });
    registerPiProvider(removed.provider);
    await node.send(provisionOf("stale", { model: { provider: removed.provider.id, modelId: "gone" }, thinkingLevel: null, task: null }), binding);
    unregisterPiProvider(removed.provider.id);
    await expect(node.open("stale", binding)).rejects.toBeInstanceOf(NodeModelNotFoundError);
    expect(await node.send({ ...setModel("fake"), sessionId: "stale" }, binding)).toMatchObject({ ok: true });
    expect((await node.open("stale", binding)).getSessionMetadata().model).toEqual({ provider: provider.provider.id, modelId: "fake" });
    await node.close("stale");
  } finally { node.stop(); unregisterPiProvider(provider.provider.id); setNodeDb(); db.close(); rmSync(repo, { recursive: true, force: true }); }
});

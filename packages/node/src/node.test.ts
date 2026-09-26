import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { APPLICATION_ERROR } from "./protocol/errors.js";
import { RpcFailure } from "./protocol/peer.js";
import { startNode } from "./node.js";
import { nodeAdmissionReceipt, setNodeDb } from "./storage.js";
import { registerPiProvider, unregisterPiProvider } from "./runtime/context.js";
import { NodeModelNotFoundError, type NodeRuntimePolicy } from "./runtime/build.js";
import type { SessionConfiguration, SessionEventReport, SessionSettled, SessionStarted } from "./protocol/schema.js";

const noTools = {
  executeScript: async () => { throw new Error("unexpected tool call"); },
  searchScript: async () => { throw new Error("unexpected tool call"); },
  createTask: async () => { throw new Error("unexpected tool call"); },
};
const noReports = { started: async () => {}, settled: async () => {}, configuration: async (): Promise<never> => { throw new Error("runtime opened"); }, ...noTools };
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
    expect(await node.send({ op: "session.provision", sessionId: "owned", sourceId: 7 }, binding)).toMatchObject({ ok: true });
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
    await node.send({ op: "session.provision", sessionId: "s", sourceId: 7 }, binding);
    db.query(`INSERT INTO session_messages(session_id,seq,harness_id,role,message_json,created_at)
      VALUES(?,?,?,?,?,?)`).run("s", 1, "entry-1", "reinsInput", JSON.stringify({
        type: "message", message: { role: "reinsInput", content: [
          { type: "image", attachmentId: "old", mimeType: "image/png", byteSize: 1 },
        ] },
      }), binding.createdAt);
    await expect(node.open("s", binding)).rejects.toThrow("runtime opened");
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
    expect(await reinstalled.send({ op: "session.provision", sessionId: "s", sourceId: 7 }, binding)).toMatchObject({ ok: true });
    await expect(reinstalled.send({ op: "session.prompt", sessionId: "s", clientId: "image", content: [
      { type: "image", attachmentId: "new-image", mimeType: "image/png", byteSize: bytes.length },
    ] }, binding)).rejects.toThrow("runtime opened");
    expect(fetches).toBe(1);
    expect(db.query("SELECT data FROM node_attachments WHERE session_id = ? AND attachment_id = ?").get("s", "new-image"))
      .toEqual({ data: bytes });
  } finally { first.stop(); reinstalled.stop(); setNodeDb(); db.close(); }
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
    configuration: async () => ({ model: { provider: provider.provider.id, modelId: "fake" }, thinkingLevel: null, task: null }),
    ...noTools,
  };
  setNodeDb(db);
  const dependencies = { credentials: { ...credentials, list: async () => [{ providerId: provider.provider.id, type: "api_key" as const }] } };
  const binding = { sourceId: 7, cwd: "/tmp/reins-node-owner", createdAt: "2026-01-01T00:00:00.000Z", parentSessionId: null };
  const provision = { op: "session.provision" as const, sessionId: "s", sourceId: 7 };
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
    // Opening needs the server's session configuration: with no connection the open fails clearly.
    await expect(restarted.send(steer, binding)).rejects.toThrow("Session configuration unavailable: Server connection unavailable");
    // A connection that only answers configuration: events are dropped and reports stay pending.
    const detachOffline = restarted.attach({ ...recorder, event: () => {},
      committed: async () => { throw new Error("offline"); }, started: async () => { throw new Error("offline"); }, settled: async () => { throw new Error("offline"); } });
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
    detachOffline();
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
    configuration: async () => ({ model: { provider: provider.provider.id, modelId: "fake" }, thinkingLevel: null, task: null }),
  });
  const binding = { sourceId: 7, cwd: "/tmp/reins-node-child", createdAt: "2026-01-01T00:00:00.000Z", parentSessionId: "parent" };
  const cleanup = () => { node.stop(); unregisterPiProvider(provider.provider.id); setNodeDb(); db.close(); };
  return { node, binding, received, provider, cleanup };
}

test("a child session's durable settlement carries its model and final reply after the run's commits, before the next run starts", async () => {
  const { node, binding, received, provider, cleanup } = childNode(new Database(":memory:"), "node-child-faux", ["child answer", "second answer"]);
  try {
    await node.send({ op: "session.provision", sessionId: "child", sourceId: 7 }, binding);
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
  const { node, binding, received, cleanup } = childNode(new Database(":memory:"), "node-child-reply-faux", ["unread answer"]);
  const errors = spyOn(console, "error").mockImplementation(() => {});
  try {
    await node.send({ op: "session.provision", sessionId: "child", sourceId: 7 }, binding);
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
    configuration: async () => ({ model: { provider: provider.provider.id, modelId: "fake" }, thinkingLevel: null, task: null }),
    executeScript: async input => { calls.push(["execute", input]); return { ok: true, text: "1" }; },
    searchScript: async input => { calls.push(["search", input]); throw new RpcFailure(APPLICATION_ERROR, "Node session unavailable: s"); },
    createTask: async input => { calls.push(["createTask", input]); throw new RpcFailure("unavailable", "Call timed out after 60000ms; outcome unknown", "unknown"); },
  });
  const binding = { sourceId: 7, cwd: "/tmp/reins-node-tools", createdAt: "2026-01-01T00:00:00.000Z", parentSessionId: null };
  const results = async () => Object.fromEntries((await runtime.getMessages()).filter(message => message.role === "toolResult")
    .map(message => [message.toolCallId, (message.content ?? []).map(block => block.type === "text" ? block.text : "").join("")]));
  let runtime!: Awaited<ReturnType<typeof node.open>>;
  try {
    await node.send({ op: "session.provision", sessionId: "s", sourceId: 7 }, binding);
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

test("opening a task session checks out its branch on the node before building Pi; a server rejection fails the open", async () => {
  const db = new Database(":memory:");
  const repo = mkdtempSync(join(tmpdir(), "reins-node-checkout-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  git("branch", "task/feature");
  setNodeDb(db);
  const node = startNode({ credentials });
  // An unknown model stops the open right after checkout, so no Pi provider is needed.
  let answer: SessionConfiguration | Error = { model: { provider: "none", modelId: "missing" }, thinkingLevel: null,
    task: { title: "Feature", description: null, branchName: "task/feature" } };
  const requests: unknown[] = [];
  node.attach({ ...noReports, committed: async () => {}, fetchAttachment: async () => null, event: () => {},
    configuration: async input => { requests.push(input); if (answer instanceof Error) throw answer; return answer; } });
  const binding = { sourceId: 7, cwd: repo, createdAt: "2026-01-01T00:00:00.000Z", parentSessionId: null };
  const checkouts = () => git("reflog").split("\n").filter(line => line.includes("checkout:")).length;
  try {
    await node.send({ op: "session.provision", sessionId: "s", sourceId: 7 }, binding);
    await expect(node.open("s", binding)).rejects.toBeInstanceOf(NodeModelNotFoundError);
    expect(requests).toEqual([{ sessionId: "s", binding }]);
    expect(git("rev-parse", "--abbrev-ref", "HEAD")).toBe("task/feature");
    const before = checkouts();
    await expect(node.open("s", binding)).rejects.toBeInstanceOf(NodeModelNotFoundError);
    expect(checkouts()).toBe(before); // Already on the branch: no checkout.

    answer = { model: null, thinkingLevel: null, task: { title: "Gone", description: null, branchName: "task/missing" } };
    await expect(node.open("s", binding)).rejects.toThrow(/git checkout failed \(exit 1\):.*task\/missing/);
    expect(git("rev-parse", "--abbrev-ref", "HEAD")).toBe("task/feature");
    expect(node.hasRuntime("s")).toBe(false);

    answer = new RpcFailure(APPLICATION_ERROR, "Node session binding mismatch: s");
    await expect(node.open("s", binding)).rejects.toThrow(/^Node session binding mismatch: s$/);
  } finally { node.stop(); setNodeDb(); db.close(); rmSync(repo, { recursive: true, force: true }); }
});

import { NODE_COMMAND_TIMEOUTS } from "../../node-link/node-hub.js";
import { openingTarget, connectScriptedNode, directLink, loopbackNodeFor, stopLoopbackNode } from "../helpers/loopback-node.js";
import { DeliveryDeferred, type LaneSeed, type NodeCommand } from "@reins/node-protocol";
import { nodeSession } from "../helpers/node-session.js";
import { test, expect, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { setDb } from "../../db.js";
import { runMigrations } from "../../migrations.js";
import { createProject } from "../../project-store.js";
import { defaultSource } from "../../node-store.js";
import { createSession } from "../../session-store.js";
import { storeSessionAttachment } from "../../session-attachments-store.js";
import { sessionRoute } from "../../nodes/commands.js";
import { createServerState } from "../helpers/server-state.js";
import { createTask } from "../../task-store.js";
import { setSetting } from "../../settings-store.js";

const text = (value: string) => [{ type: "text" as const, text: value }];

test("prompt with an image reference, steer, setModel, abort and resumePending cross the node link; the prompt's attachment.fetch re-enters the same link", async () => {
  const contexts: string[] = [];
  const { db, state, target, provider, untilSettled, inputs, lane, dispose } = await nodeSession("wire-commands", [
    context => { contexts.push(JSON.stringify(context.messages)); return fauxAssistantMessage("Seen"); }, fauxAssistantMessage("Steered"),
  ]);
  const node = loopbackNodeFor(state);
  const served = (["prompt", "steer", "setModel", "abort", "resumePending"] as const).map(method => spyOn(node, method));
  try {
    const stored = storeSessionAttachment("s", { data: new Uint8Array([1, 2, 3]), mimeType: "image/png" });
    const image = { type: "image" as const, attachmentId: stored.id, mimeType: "image/png" as const, byteSize: 3, sha256: stored.sha256 };
    const prompt: NodeCommand = { op: "session.prompt", sessionId: "s", clientId: "p1", content: [...text("Look"), image], sourceSessionId: null };
    // The node serves session.prompt by calling attachment.fetch back over the same link before admission.
    expect(await target.send(prompt)).toEqual({ ok: true, value: { inputId: "p1" } });
    await untilSettled(1);
    // The node hydrated the reference for the provider from the bytes it fetched.
    expect(contexts[0]).toContain(Buffer.from([1, 2, 3]).toString("base64"));

    expect(await target.send({ op: "session.steer", sessionId: "s", clientId: "s1", content: text("And then?"), sourceSessionId: null }))
      .toEqual({ ok: true, value: { inputId: "s1" } });
    await untilSettled(2);
    expect([inputs("p1"), inputs("s1")]).toEqual([1, 1]);

    expect(await target.send({ op: "session.setModel", sessionId: "s", provider: provider.provider.id, modelId: "other", thinkingLevel: "high" }))
      .toEqual({ ok: true, value: { modelSet: true } });
    expect(lane()).toMatchObject({ model: { provider: provider.provider.id, modelId: "other" }, thinkingLevel: "high" });

    // Nothing is running: abort reports so without starting anything; there is no pending operation to resume.
    expect(await target.send({ op: "session.abort", sessionId: "s" })).toEqual({ ok: true, value: { aborted: false } });
    expect(await target.send({ op: "session.resumePending", sessionId: "s" }))
      .toEqual({ ok: false, error: { code: "internal", message: "Lane 'main' has no pending inactive operation", retryable: false } });
    // Every command reached the node through its own wire handler, once.
    expect(served.map(spy => spy.mock.calls.length)).toEqual([1, 1, 1, 1, 1]);
    expect(db.query("SELECT COUNT(*) n FROM node_command_outbox").get()).toEqual({ n: 0 });
  } finally { for (const spy of served) spy.mockRestore(); await dispose(); }
}, 15_000);

test("abort of a running node run crosses the link and stops it", async () => {
  let started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  const { target, untilSettled, db, dispose } = await nodeSession("wire-abort", [
    (_context, options) => new Promise(resolve => {
      started();
      options?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("stopped", { stopReason: "aborted" })), { once: true });
    }),
  ]);
  try {
    expect(await target.send({ op: "session.prompt", sessionId: "s", clientId: "long", content: text("Work"), sourceSessionId: null })).toMatchObject({ ok: true });
    await running;
    expect(await target.send({ op: "session.abort", sessionId: "s" })).toEqual({ ok: true, value: { aborted: true } });
    await untilSettled(1);
    expect(db.query("SELECT settlement_json FROM sessions WHERE id = 's'").get()).toMatchObject({ settlement_json: expect.stringContaining('"status":"aborted"') });
  } finally { await dispose(); }
}, 15_000);

test("node rejections keep their NodeResult codes across the wire; values the wire schema rejects never reach the node", async () => {
  const { db, target, dispose } = await nodeSession("wire-errors");
  const inputRows = () => db.query("SELECT COUNT(*) n FROM session_messages WHERE role = 'reinsInput'").get();
  try {
    const missing = { type: "image" as const, attachmentId: "att_missing", mimeType: "image/png" as const, byteSize: 3 };
    expect(await target.send({ op: "session.steer", sessionId: "s", clientId: "bad", content: [missing], sourceSessionId: null }))
      .toEqual({ ok: false, error: { code: "invalid_request", message: "Attachment unavailable: att_missing", retryable: false } });
    expect(inputRows()).toEqual({ n: 0 });
    expect(await target.send({ op: "session.setModel", sessionId: "s", provider: "nope", modelId: "m" }))
      .toEqual({ ok: false, error: { code: "invalid_request", message: "Model not found: nope/m", retryable: false } });
    // Inline image bytes are not an attachment reference: invalid params, a terminal delivery exception.
    const inline = { ...missing, data: "AAAA" };
    await expect(target.send({ op: "session.prompt", sessionId: "s", clientId: "inline", content: [inline], sourceSessionId: null })).rejects.toMatchObject({ code: -32602 });
  } finally { await dispose(); }
});

test("a call whose outcome is unknown (timeout, lost link) defers submitted work for the outbox to requeue; an immediate control fails to its caller", async () => {
  const { state, target, dispose } = await nodeSession("wire-unknown-outcome");
  try {
    const node = loopbackNodeFor(state);
    spyOn(node, "prompt").mockReturnValue(new Promise(() => {}));
    spyOn(node, "abort").mockReturnValue(new Promise(() => {}));
    spyOn(node, "resumePending").mockReturnValue(new Promise(() => {}));
    // Over a link whose input and abort bounds are 5ms.
    const link = await directLink(state, node);
    const hasty = { client: link, timeouts: { ...NODE_COMMAND_TIMEOUTS, input: 5, abort: 5 } };
    await expect(sessionRoute("s")!.send(hasty, { op: "session.prompt", sessionId: "s", clientId: "c", content: text("Hi"), sourceSessionId: null }))
      .rejects.toBeInstanceOf(DeliveryDeferred);
    expect(await sessionRoute("s")!.send(hasty, { op: "session.abort", sessionId: "s" })).toEqual({ ok: false, error: {
      code: "unavailable", message: "Node unavailable: Call timed out after 5ms; outcome unknown", retryable: true } });
    const pending = target.send({ op: "session.resumePending", sessionId: "s" });
    await Bun.sleep(1);
    await stopLoopbackNode(state);
    expect(await pending).toEqual({ ok: false, error: { code: "unavailable", message: "Node unavailable: Connection closed; outcome unknown", retryable: true } });
    // With no link at all nothing is sent: submitted work is deferred, a control is unavailable.
    await expect(sessionRoute("s")!.send(undefined, { op: "session.prompt", sessionId: "s", clientId: "c", content: text("Hi"), sourceSessionId: null }))
      .rejects.toBeInstanceOf(DeliveryDeferred);
    expect(await sessionRoute("s")!.send(undefined, { op: "session.abort", sessionId: "s" }))
      .toEqual({ ok: false, error: { code: "unavailable", message: "Node unavailable: Node not connected", retryable: true } });
  } finally { await dispose(); }
});

test("a thrown node error crosses the JSON-RPC wire as a non-retryable internal NodeResult; values that do not survive JSON fail at the wire schema", async () => {
  const { state, target, dispose } = await nodeSession("wire-thrown");
  try {
    const opening = openingTarget("s");
    const link = await directLink(state, loopbackNodeFor(state));
    spyOn(loopbackNodeFor(state), "prompt").mockRejectedValue(new Error("binding mismatch"));
    const prompt = { op: "session.prompt" as const, sessionId: "s", clientId: "c", content: text("Hi"), sourceSessionId: null };
    expect(await target.send(prompt)).toEqual({ ok: false, error: { code: "internal", message: expect.stringContaining("mismatch"), retryable: false } });
    // In-process values that do not survive JSON fail at the wire schema instead of leaking through.
    const leaky = { ...opening.binding };
    Object.defineProperty(leaky, "cwd", { value: () => opening.binding.cwd, enumerable: true });
    await expect(link.call("session.prompt", { ...opening, ...prompt, binding: leaky })).rejects.toMatchObject({ code: -32602 });
  } finally { await dispose(); }
});

test("opening commands carry the session's binding, its task read at send time and the lane seed; abort carries the binding alone", async () => {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON"); setDb(db); runMigrations(db);
  try {
    const project = createProject("opening", "/tmp/opening");
    const source = defaultSource(project.id)!;
    const task = createTask(project.id, "Fix it", "The details", "fix-it");
    createSession("task", project.id, { agentRuntimeType: "pi", sourceId: source.id, taskId: task.id, modelProvider: "anthropic", modelId: "claude-sonnet-4-5", thinkingLevel: "high" });
    createSession("scratch", project.id, { agentRuntimeType: "pi", sourceId: source.id });
    setSetting("default_model", { provider: "anthropic", modelId: "claude-haiku-4-5", runtimeType: "pi", thinkingLevel: "low" });
    const state = createServerState();
    const received: Array<[string, object]> = [];
    await connectScriptedNode(state, "internal", {
      async prompt(input) { received.push(["prompt", input]); return { inputId: input.clientId }; },
      async setModel(input) { received.push(["setModel", input]); return { modelSet: true }; },
      async resumePending(input) { received.push(["resumePending", input]); return { started: true }; },
      async abort(input) { received.push(["abort", input]); return { aborted: false }; },
    }).ready();
    db.query("UPDATE tasks SET title = 'Fix it properly' WHERE id = ?").run(task.id);
    await state.nodes.send({ op: "session.prompt", sessionId: "task", clientId: "c", content: text("Go"), sourceSessionId: null });
    await state.nodes.send({ op: "session.setModel", sessionId: "scratch", provider: "anthropic", modelId: "claude-opus-4-1" });
    await state.nodes.send({ op: "session.resumePending", sessionId: "scratch" });
    await state.nodes.send({ op: "session.abort", sessionId: "task" });

    const binding = { sourceId: source.id, cwd: "/tmp/opening", createdAt: expect.any(String), parentSessionId: null };
    const opened = { task: { title: "Fix it properly", description: "The details", branchName: "fix-it" }, lane: { model: { provider: "anthropic", modelId: "claude-sonnet-4-5" }, thinkingLevel: "high" } };
    // A scratch session with no model of its own: the current default model seeds its lane.
    const scratch = { task: null, lane: { model: { provider: "anthropic", modelId: "claude-haiku-4-5" }, thinkingLevel: "low" } };
    expect(received).toEqual([
      ["prompt", expect.objectContaining({ sessionId: "task", binding, ...opened })],
      ["setModel", expect.objectContaining({ sessionId: "scratch", binding, ...scratch, modelId: "claude-opus-4-1" })],
      ["resumePending", { sessionId: "scratch", binding, ...scratch }],
      ["abort", { sessionId: "task", binding }],
    ]);
  } finally { setDb(new Database(":memory:")); db.close(); }
});

test("the lane seed of a session without a model is the default model read at send time; its own model wins, thinking 'off' is no level; an unusable default fails the command", async () => {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON"); setDb(db); runMigrations(db);
  try {
    const project = createProject("lanes", "/tmp/lanes");
    createSession("unset", project.id, { agentRuntimeType: "pi", sourceId: defaultSource(project.id)!.id });
    createSession("own", project.id, { agentRuntimeType: "pi", sourceId: defaultSource(project.id)!.id, modelProvider: "openai", modelId: "gpt-5", thinkingLevel: "off" });
    const state = createServerState();
    const lanes: LaneSeed[] = [];
    await connectScriptedNode(state, "internal", { async resumePending(input) { lanes.push(input.lane); return { started: false }; } }).ready();
    const laneSent = async (sessionId: string) => {
      expect(await state.nodes.send({ op: "session.resumePending", sessionId })).toMatchObject({ ok: true });
      return lanes.at(-1);
    };
    expect(await laneSent("unset")).toEqual({ model: null, thinkingLevel: null });
    setSetting("default_model", { provider: "anthropic", modelId: "claude-sonnet-4-5", runtimeType: "pi", thinkingLevel: "high" });
    expect(await laneSent("unset")).toEqual({ model: { provider: "anthropic", modelId: "claude-sonnet-4-5" }, thinkingLevel: "high" });
    // Read when the command is sent: a later default applies to a session whose lane is not seeded yet.
    setSetting("default_model", { provider: "anthropic", modelId: "claude-haiku-4-5", runtimeType: "pi", thinkingLevel: "low" });
    expect(await laneSent("unset")).toEqual({ model: { provider: "anthropic", modelId: "claude-haiku-4-5" }, thinkingLevel: "low" });
    expect(await laneSent("own")).toEqual({ model: { provider: "openai", modelId: "gpt-5" }, thinkingLevel: null });
    // A default on another runtime is not routed through Pi: the command fails to send.
    setSetting("default_model", { provider: "claude_agent_sdk", modelId: "claude-sonnet-4-6", runtimeType: "claude_agent_sdk", thinkingLevel: "high" });
    await expect(state.nodes.send({ op: "session.resumePending", sessionId: "unset" })).rejects.toThrow("Configured default_model uses unavailable runtime 'claude_agent_sdk'");
    expect(lanes).toHaveLength(4);
  } finally { setDb(new Database(":memory:")); db.close(); }
});


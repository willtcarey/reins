import { sessionContextOf, connectScriptedNode, loopbackNodeFor, stopLoopbackNode } from "../helpers/loopback-node.js";
import { Sessions } from "../../models/sessions.js";
import { DeliveryDeferred, type LaneSeed, type NodeCommand, INVALID_PARAMS } from "@reins/node-protocol";
import { deliverNow, nodeSession } from "../helpers/node-session.js";
import { test, expect, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { setDb } from "../../db.js";
import { runMigrations } from "../../migrations.js";
import { createProject } from "../project-fixture.js";
import { defaultSource } from "../../node-store.js";
import { createSession } from "../../session-store.js";
import { storeSessionAttachment } from "../../session-attachments-store.js";
import { createServerState } from "../helpers/server-state.js";
import { createTask } from "../../task-store.js";
import { setSetting } from "../../settings-store.js";
import { reinsSystemPrompt } from "../../sessions/system-prompt.js";
import { registerSessionKind } from "../../sessions/session-kinds.js";

const text = (value: string) => [{ type: "text" as const, text: value }];

test("delivered prompt with an image reference, steer and setModel cross the node link; the prompt's attachment.fetch re-enters the same link", async () => {
  const contexts: string[] = [];
  const { db, state, target, provider, untilSettled, inputs, lane, dispose } = await nodeSession("wire-commands", [
    context => { contexts.push(JSON.stringify(context.messages)); return fauxAssistantMessage("Seen"); }, fauxAssistantMessage("Steered"),
  ]);
  const node = loopbackNodeFor(state);
  const served = (["prompt", "steer", "setModel"] as const).map(method => spyOn(node, method));
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
    // Every command reached the node through its own wire handler, once.
    expect(served.map(spy => spy.mock.calls.length)).toEqual([1, 1, 1]);
    expect(db.query("SELECT COUNT(*) n FROM node_command_outbox").get()).toEqual({ n: 0 });
  } finally { for (const spy of served) spy.mockRestore(); await dispose(); }
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
    await expect(target.send({ op: "session.prompt", sessionId: "s", clientId: "inline", content: [inline], sourceSessionId: null })).rejects.toMatchObject({ code: INVALID_PARAMS });
  } finally { await dispose(); }
});

test("a delivery whose outcome is unknown (timeout, lost link) or that is never sent is deferred for the outbox to requeue", async () => {
  const { state, target, dispose } = await nodeSession("wire-unknown-outcome");
  try {
    const prompt: NodeCommand = { op: "session.prompt", sessionId: "s", clientId: "c", content: text("Hi"), sourceSessionId: null };
    spyOn(loopbackNodeFor(state), "prompt").mockReturnValue(new Promise(() => {}));
    // Bounded at 5ms.
    await expect(deliverNow(state, prompt, { input: 5, setModel: 5 })).rejects.toThrow(new DeliveryDeferred("Call timed out after 5ms; outcome unknown"));
    const pending = target.send(prompt);
    await Bun.sleep(1);
    await stopLoopbackNode(state);
    await expect(pending).rejects.toThrow(new DeliveryDeferred("Connection closed; outcome unknown"));
    // With no link at all nothing is sent.
    await expect(target.send(prompt)).rejects.toThrow(new DeliveryDeferred("Node not connected"));
  } finally { await dispose(); }
});

test("a thrown node error crosses the JSON-RPC wire as a non-retryable internal NodeResult; values that do not survive JSON fail at the wire schema", async () => {
  const { state, target, dispose } = await nodeSession("wire-thrown");
  try {
    const opening = sessionContextOf("s");
    spyOn(loopbackNodeFor(state), "prompt").mockRejectedValue(new Error("binding mismatch"));
    const prompt = { op: "session.prompt" as const, sessionId: "s", clientId: "c", content: text("Hi"), sourceSessionId: null };
    expect(await target.send(prompt)).toEqual({ ok: false, error: { code: "internal", message: expect.stringContaining("mismatch"), retryable: false } });
    // In-process values that do not survive JSON fail at the wire schema instead of leaking through.
    const leaky = { ...opening.binding };
    Object.defineProperty(leaky, "cwd", { value: () => opening.binding.cwd, enumerable: true });
    await expect(state.nodes.get("internal").request("session.prompt", { ...opening, ...prompt, binding: leaky })).rejects.toMatchObject({ code: INVALID_PARAMS });
  } finally { await dispose(); }
});

test("opening calls (outbox commands, resumePending) carry the session's binding, its task branch, the lane seed and its kind's runtime, resolved at send time; abort carries the binding alone", async () => {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON"); setDb(db); runMigrations(db);
  const unregister = registerSessionKind("test-summary", ({ task }) => ({ systemPrompt: `Summarize ${task?.title}.`, tools: [], environment: false }));
  try {
    const project = createProject("opening", "/tmp/opening");
    const source = defaultSource(project.id)!;
    const task = createTask(project.id, "Fix it", "The details", "fix-it");
    createSession("task", project.id, { agentRuntimeType: "pi", sourceId: source.id, taskId: task.id, modelProvider: "anthropic", modelId: "claude-sonnet-4-5", thinkingLevel: "high" });
    createSession("scratch", project.id, { agentRuntimeType: "pi", sourceId: source.id });
    createSession("summary", project.id, { agentRuntimeType: "pi", sourceId: source.id, taskId: task.id, kind: "test-summary" });
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
    await deliverNow(state, { op: "session.prompt", sessionId: "task", clientId: "c", content: text("Go"), sourceSessionId: null });
    await deliverNow(state, { op: "session.setModel", sessionId: "scratch", provider: "anthropic", modelId: "claude-opus-4-1" });
    await new Sessions(state.nodes).resume("scratch");
    await new Sessions(state.nodes).abort("task");
    await new Sessions(state.nodes).resume("summary");

    const binding = { sourceId: source.id, cwd: "/tmp/opening", createdAt: expect.any(String), parentSessionId: null };
    // The task as it is when the command is sent: the server's prompt tells the session its task, and the
    // node appends its environment and offers every tool.
    const opened = {
      branch: "fix-it", lane: { model: { provider: "anthropic", modelId: "claude-sonnet-4-5" }, thinkingLevel: "high" },
      runtime: { systemPrompt: reinsSystemPrompt({ task: { title: "Fix it properly", description: "The details" } }), environment: true },
    };
    // A scratch session with no model of its own: the current default model seeds its lane.
    const scratch = {
      branch: null, lane: { model: { provider: "anthropic", modelId: "claude-haiku-4-5" }, thinkingLevel: "low" },
      runtime: { systemPrompt: reinsSystemPrompt({ task: null }), environment: true },
    };
    expect(opened.runtime.systemPrompt).toContain("Title: Fix it properly");
    expect(scratch.runtime.systemPrompt).toContain("This is a project assistant session");
    expect(received).toEqual([
      ["prompt", expect.objectContaining({ sessionId: "task", binding, ...opened })],
      ["setModel", expect.objectContaining({ sessionId: "scratch", binding, ...scratch, modelId: "claude-opus-4-1" })],
      ["resumePending", { sessionId: "scratch", binding, ...scratch }],
      ["abort", { sessionId: "task", binding }],
      // Another kind resolves its own runtime from the session's rows. A utility kind has no side effects:
      // though its session is on the task, it names no branch, so the node checks nothing out for it.
      ["resumePending", { sessionId: "summary", binding, branch: null, lane: scratch.lane, runtime: { systemPrompt: "Summarize Fix it properly.", tools: [], environment: false } }],
    ]);
  } finally { unregister(); setDb(new Database(":memory:")); db.close(); }
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
      expect(await new Sessions(state.nodes).resume(sessionId)).toEqual({ started: false });
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
    await expect(new Sessions(state.nodes).resume("unset")).rejects.toThrow("Configured default_model uses unavailable runtime 'claude_agent_sdk'");
    expect(lanes).toHaveLength(4);
  } finally { setDb(new Database(":memory:")); db.close(); }
});


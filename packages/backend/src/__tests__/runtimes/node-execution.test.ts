import { test, expect, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { fauxAssistantMessage, fauxProvider, type FauxResponseStep } from "@earendil-works/pi-ai";
import { DeliveryDeferred, type NodeCommand } from "@reins/node-protocol";
import type { Node } from "@reins/node/node";
import { setDb } from "../../db.js";
import { storedInput } from "../../pi-session-store.js";
import { runMigrations } from "../../migrations.js";
import { createProject } from "../../project-store.js";
import { createSource, defaultSource } from "../../node-store.js";
import { createSession, getSession } from "../../session-store.js";
import { storeSessionAttachment } from "../../session-attachments-store.js";
import { enqueueInput, enqueueSetModel, getCommand, pendingInputs } from "../../node-command-store.js";
import { recoverInterruptedDispatches } from "../../node-command-recovery.js";
import { getNodeCommand } from "../../node-command-store.js";
import { deliverCommand } from "../../models/node-command-dispatcher.js";
import { selectCreationSource, sessionTarget } from "../../runtimes/node-source.js";
import { createNewSession } from "../../runtimes/session-manager.js";
import { connectScriptedNode, directLink, drainCommands, loopbackLink, loopbackNodeFor, stopLoopbackNode } from "../helpers/loopback-node.js";
import { deliverToNode } from "../../node-transport/commands.js";
import { NODE_COMMAND_TIMEOUTS } from "../../runtimes/node-hub.js";
import { registerPiProvider, unregisterPiProvider } from "../helpers/pi-providers.js";
import { setApiKeyCredential } from "../../auth-credentials-store.js";
import { createServerState } from "../helpers/server-state.js";
import { Sessions } from "../../models/sessions.js";
import { submit } from "../../runtimes/node-execution.js";
import { createTask } from "../../task-store.js";
import { setSetting } from "../../settings-store.js";

/** Session "s" on the seeded node's loopback link, on a faux model whose replies the test scripts. */
async function nodeSession(name: string, responses: FauxResponseStep[] = []) {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON"); setDb(db); runMigrations(db);
  const provider = fauxProvider({ provider: name, models: [{ id: "fake", input: ["text", "image"], contextWindow: 200_000, maxTokens: 1_000 }, { id: "other" }] });
  provider.setResponses(responses);
  registerPiProvider(provider.provider);
  setApiKeyCredential(provider.provider.id, "test-key");
  const state = createServerState(undefined, { loopbackNode: true });
  const project = createProject(name, "/tmp/node-commands");
  const source = defaultSource(project.id)!;
  createSession("s", project.id, { agentRuntimeType: "pi", sourceId: source.id, modelProvider: provider.provider.id, modelId: "fake" });
  await loopbackLink(state).ready();
  const target = state.nodes;
  // Settled runs as the server applied them from the node's lifecycle reports.
  const settled = () => db.query<{ n: number }, []>("SELECT settlement_count n FROM sessions WHERE id = 's'").get()!.n;
  // Runs the model answered, in the server's storage: a duplicate admission would add one.
  const replies = () => db.query<{ n: number }, []>("SELECT COUNT(*) n FROM session_messages WHERE session_id = 's' AND role = 'assistant'").get()!.n;
  const untilSettled = async (runs: number) => { for (let i = 0; i < 400 && settled() < runs; i++) await Bun.sleep(5); expect(settled()).toBe(runs); };
  // Inputs Pi holds for a client ID in the session's transcript.
  const inputs = (clientId: string) => db.query<{ n: number }, [string]>("SELECT COUNT(*) n FROM session_messages WHERE session_id = 's' AND message_json LIKE ?").get(`%"reinsId":"${clientId}"%`)!.n;
  // Pi's main lane configuration (its model), in the server's storage.
  const lane = () => JSON.parse(db.query<{ value_json: string }, []>("SELECT value_json FROM pi_values WHERE session_id = 's' AND namespace = 'pi.lane.config'").get()!.value_json);
  const dispose = async () => { await stopLoopbackNode(state); unregisterPiProvider(provider.provider.id); setDb(new Database(":memory:")); db.close(); };
  return { db, state, project, source, target, provider, settled, untilSettled, inputs, replies, lane, dispose };
}

/** What the session's opening commands carry (its binding, task snapshot and lane seed), as delivery resolves it. */
const commandTarget = (sessionId: string) => { const { nodeId: _nodeId, ...target } = sessionTarget(sessionId); return target; };
const text = (value: string) => [{ type: "text" as const, text: value }];
/** Admits a stored prompt/steer on the node directly, as a node crash right after Pi admission leaves it. */
const admitDirectly = (node: Node, command: NodeCommand) => {
  if (command.op !== "session.prompt" && command.op !== "session.steer") throw new Error(`Not an input: ${command.op}`);
  const input = { sessionId: command.sessionId, ...commandTarget(command.sessionId), clientId: command.clientId, content: command.content, sourceSessionId: command.sourceSessionId };
  return command.op === "session.prompt" ? node.prompt(input) : node.steer(input);
};

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

test("input for a session runs on the node of its source, and the delivered input leaves the outbox", async () => {
  const { db, state, untilSettled, replies, dispose } = await nodeSession("session-input", [fauxAssistantMessage("Hello")]);
  try {
    expect(new Sessions(state.nodes).get("s")?.placement).toEqual({ available: true, nodeId: "internal", nodeName: "Internal" });
    submit(state.nodes, "s", { op: "prompt", content: text("Hi"), clientId: "c1" });
    await untilSettled(1);
    expect(replies()).toBe(1);
    expect(db.query("SELECT COUNT(*) n FROM node_command_outbox").get()).toEqual({ n: 0 });
    expect(storedInput("s", "c1")).toMatchObject({ seq: expect.any(Number) });
    // A replay of the admitted input is recognized from the server's storage and queues nothing.
    submit(state.nodes, "s", { op: "prompt", content: text("Hi"), clientId: "c1" });
    expect(db.query("SELECT COUNT(*) n FROM node_command_outbox").get()).toEqual({ n: 0 });
  } finally { await dispose(); }
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

test("immediate controls fail to their caller when the link is lost or the call times out; they are never requeued", async () => {
  const { state, target, dispose } = await nodeSession("wire-controls");
  try {
    const node = loopbackNodeFor(state);
    spyOn(node, "abort").mockReturnValue(new Promise(() => {}));
    spyOn(node, "resumePending").mockReturnValue(new Promise(() => {}));
    // Over a link whose abort bound is 5ms.
    const link = await directLink(state, node);
    expect(await deliverToNode({ link: () => link, timeouts: { ...NODE_COMMAND_TIMEOUTS, abort: 5 } }, { op: "session.abort", sessionId: "s" })).toEqual({ ok: false, error: {
      code: "unavailable", message: "Node unavailable: Call timed out after 5ms; outcome unknown", retryable: true } });
    const pending = target.send({ op: "session.resumePending", sessionId: "s" });
    await Bun.sleep(1);
    await stopLoopbackNode(state);
    expect(await pending).toEqual({ ok: false, error: { code: "unavailable", message: "Node unavailable: Connection closed; outcome unknown", retryable: true } });
  } finally { await dispose(); }
});

test("a prompt or setModel whose outcome is unknown is requeued, and its replay converges without a second admission", async () => {
  const { state, target, untilSettled, inputs, replies, provider, lane, dispose } = await nodeSession("wire-unknown", [fauxAssistantMessage("Once")]);
  try {
    // Admission outlasts the call: the reply is lost but the node admits.
    const node = loopbackNodeFor(state);
    const [admit, apply] = [node.prompt.bind(node), node.setModel.bind(node)];
    const slow = [
      spyOn(node, "prompt").mockImplementation(async input => { await Bun.sleep(30); return admit(input); }),
      spyOn(node, "setModel").mockImplementation(async input => { await Bun.sleep(30); return apply(input); }),
    ];
    // Sent over a link whose input and setModel bounds are 5ms.
    const link = await directLink(state, node);
    const hasty = (command: NodeCommand) => deliverToNode({ link: () => link, timeouts: { ...NODE_COMMAND_TIMEOUTS, input: 5, setModel: 5 } }, command);
    const id = enqueueInput("s", "prompt", text("Once"), "once")!;
    const command = getNodeCommand(id)!.command!;
    await deliverCommand(id, () => hasty(command));
    expect(getCommand(id)?.state).toBe("queued");
    for (let i = 0; i < 200 && inputs("once") === 0; i++) await Bun.sleep(5);
    // The replay is recognized by Pi's durable input ID and answered.
    await drainCommands(state);
    expect(getNodeCommand(id)).toBeNull();
    await untilSettled(1);
    expect(inputs("once")).toBe(1);

    const setModel: NodeCommand = { op: "session.setModel", sessionId: "s", provider: provider.provider.id, modelId: "other" };
    await expect(hasty(setModel)).rejects.toBeInstanceOf(DeliveryDeferred);
    for (let i = 0; i < 200 && lane().model.modelId !== "other"; i++) await Bun.sleep(5);
    for (const spy of slow) spy.mockRestore();
    // The replay applies the same absolute selection again.
    expect(await target.send(setModel)).toEqual({ ok: true, value: { modelSet: true } });
    expect(lane()).toMatchObject({ model: { provider: provider.provider.id, modelId: "other" } });
    expect(replies()).toBe(1);
  } finally { await dispose(); }
}, 15_000);

test("crash window: Pi admitted a prompt or steer but the server never learned it; the replay is recognized by Pi and admits nothing twice", async () => {
  const { state, untilSettled, inputs, replies, dispose } = await nodeSession("wire-crash", [fauxAssistantMessage("First"), fauxAssistantMessage("Second")]);
  try {
    const node = loopbackNodeFor(state);
    for (const [op, clientId, runs] of [["prompt", "crashed-prompt", 1], ["steer", "crashed-steer", 2]] as const) {
      const id = enqueueInput("s", op, text(clientId), clientId)!;
      const command = getNodeCommand(id)!.command!;
      // Admission the server never heard of: what a node crash right after Pi admission leaves.
      expect(await admitDirectly(node, command)).toEqual({ inputId: clientId });
      await untilSettled(runs);
      // The server never learned the outcome and replays the stored command over the wire.
      await drainCommands(state);
      expect(getNodeCommand(id)).toBeNull();
      await Bun.sleep(50);
      expect(inputs(clientId)).toBe(1);
      expect(replies()).toBe(runs);
    }
  } finally { await dispose(); }
}, 15_000);

test("a server restart interrupting deliveries requeues them: an input the node admitted converges on replay, one it never received and a model change are delivered once, in order", async () => {
  const { db, state, provider, untilSettled, inputs, replies, lane, dispose } = await nodeSession("restart-requeue", [
    fauxAssistantMessage("Admitted"), fauxAssistantMessage("Lost"), fauxAssistantMessage("Behind"),
  ]);
  /** The server stops while `id` is being delivered, and startup recovery runs in the next process. */
  const restartDuring = (id: string) => {
    db.query("UPDATE node_command_outbox SET state = 'dispatching' WHERE id = ?").run(id);
    expect(recoverInterruptedDispatches(db)).toBe(1);
    expect(getCommand(id)?.state).toBe("queued");
  };
  try {
    const node = loopbackNodeFor(state);
    const prompts = spyOn(node, "prompt");
    const modelChanges = spyOn(node, "setModel");

    // The node admitted the prompt; the server stopped before it learned so.
    const admitted = enqueueInput("s", "prompt", text("admitted"), "admitted")!;
    expect(await admitDirectly(node, getNodeCommand(admitted)!.command!)).toEqual({ inputId: "admitted" });
    await untilSettled(1);
    restartDuring(admitted);
    await drainCommands(state);
    expect(getCommand(admitted)).toBeNull();
    expect(inputs("admitted")).toBe(1);
    expect(replies()).toBe(1);

    // The node never received the prompt.
    const lost = enqueueInput("s", "prompt", text("lost"), "lost")!;
    restartDuring(lost);
    prompts.mockClear();
    await drainCommands(state);
    await untilSettled(2);
    expect(getCommand(lost)).toBeNull();
    expect(prompts.mock.calls.map(([input]) => input.clientId)).toEqual(["lost"]);
    expect([inputs("lost"), replies()]).toEqual([1, 2]);

    // An interrupted model change is applied once after the restart, still ahead of the prompt queued
    // behind it: that prompt runs on the new model.
    const change = enqueueSetModel("s", { provider: provider.provider.id, modelId: "other" });
    const behind = enqueueInput("s", "prompt", text("behind"), "behind")!;
    restartDuring(change);
    prompts.mockClear();
    await drainCommands(state);
    await untilSettled(3);
    expect([getCommand(change), getCommand(behind)]).toEqual([null, null]);
    expect(modelChanges).toHaveBeenCalledTimes(1);
    expect(prompts).toHaveBeenCalledTimes(1);
    expect(modelChanges.mock.invocationCallOrder[0]).toBeLessThan(prompts.mock.invocationCallOrder[0]!);
    expect(lane()).toMatchObject({ model: { provider: provider.provider.id, modelId: "other" } });
    const last = db.query<{ message_json: string }, []>("SELECT message_json FROM session_messages WHERE session_id = 's' AND role = 'assistant' ORDER BY seq DESC").get()!;
    expect(JSON.parse(last.message_json).message).toMatchObject({ content: [{ type: "text", text: "Behind" }], model: "other" });
    expect([inputs("behind"), replies()]).toEqual([1, 3]);
  } finally { await dispose(); }
}, 15_000);

test("crash window while queued: a steer Pi holds in its queue behind a running run is recognized on replay", async () => {
  let release!: () => void;
  let started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  const { state, target, untilSettled, inputs, dispose } = await nodeSession("wire-queued", [
    () => new Promise(resolve => { started(); release = () => resolve(fauxAssistantMessage("Released")); }),
    fauxAssistantMessage("After steer"),
  ]);
  try {
    expect(await target.send({ op: "session.prompt", sessionId: "s", clientId: "block", content: text("Work"), sourceSessionId: null })).toMatchObject({ ok: true });
    await running;
    const id = enqueueInput("s", "steer", text("queued"), "queued")!;
    expect(await admitDirectly(loopbackNodeFor(state), getNodeCommand(id)!.command!)).toEqual({ inputId: "queued" });
    // The server's storage already proves the admission: Pi committed its pending steering entry before the reply.
    expect(storedInput("s", "queued")).toEqual({ queued: true });
    // Replayed while Pi still holds the steer in its queue (not yet a transcript entry).
    await drainCommands(state);
    expect(getNodeCommand(id)).toBeNull();
    release();
    await untilSettled(1);
    expect(inputs("queued")).toBe(1);
  } finally { await dispose(); }
}, 15_000);

test("a new session is placed on its project's default source (its first) unless the caller names one; input for a node that is not connected waits", async () => {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON"); setDb(db); runMigrations(db);
  try {
    const project = createProject("a", "/tmp/a");
    // The source the project was created with.
    const first = defaultSource(project.id)!;
    expect(first).toMatchObject({ project_id: project.id, path: "/tmp/a" });
    db.exec("INSERT INTO nodes VALUES ('remote', 'Remote')");
    const remote = createSource(project.id, "remote", "/remote/a");
    expect(defaultSource(project.id)).toEqual(first);
    expect(selectCreationSource(project.id)).toEqual(first);
    expect(selectCreationSource(project.id, remote.id)).toEqual(remote);
    const other = createProject("b", "/tmp/b");
    expect(() => selectCreationSource(project.id, defaultSource(other.id)!.id)).toThrow(`Execution source unavailable for project ${project.id}`);

    const state = createServerState();
    expect(getSession(createNewSession(state, project.id).id)?.source_id).toBe(first.id);
    const far = createNewSession(state, project.id, { sourceId: remote.id });
    expect(getSession(far.id)?.source_id).toBe(remote.id);
    // Queued until the remote node connects, not rejected.
    submit(state.nodes, far.id, { op: "steer", content: text("hi"), clientId: "c" });
    await drainCommands(state);
    expect(pendingInputs(far.id)).toEqual([{ id: expect.any(String), clientId: "c" }]);
  } finally { setDb(new Database(":memory:")); db.close(); }
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

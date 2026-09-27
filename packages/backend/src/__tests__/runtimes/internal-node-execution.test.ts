import { test, expect, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { fauxAssistantMessage, fauxProvider, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { NodeCommand } from "@reins/node/contract";
import { setNodeDb } from "@reins/node/storage";
import { setDb } from "../../db.js";
import { runMigrations } from "../../migrations.js";
import { createProject } from "../../project-store.js";
import { internalSource } from "../../node-store.js";
import { createSession, getSession } from "../../session-store.js";
import { storeSessionAttachment } from "../../session-attachments-store.js";
import { enqueueInput } from "../../node-command-store.js";
import { getWork } from "../../models/node-command-projection.js";
import { NodeCommandDispatcher } from "../../models/node-command-dispatcher.js";
import { deliverCommand, DeliveryDeferred } from "../../models/node-command-transport.js";
import { executionTargetFor } from "../../runtimes/execution-target.js";
import { internalNodeExecutionTarget } from "../../runtimes/internal-node-execution.js";
import { provisionForSession } from "../../runtimes/internal-node.js";
import { internalNodeFor, stopInternalNode } from "../helpers/loopback-node.js";
import { NODE_COMMAND_TIMEOUTS } from "../../node-transport/commands.js";
import { registerPiProvider, unregisterPiProvider } from "../../runtimes/pi/factory.js";
import { setApiKeyCredential } from "../../auth-credentials-store.js";
import { createServerState } from "../helpers/server-state.js";

/** A node-owned session on the internal link, with a faux model whose replies the test scripts. */
function nodeSession(name: string, responses: FauxResponseStep[] = []) {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON"); setDb(db); runMigrations(db);
  const nodeDb = new Database(":memory:");
  setNodeDb(nodeDb);
  const provider = fauxProvider({ provider: name, models: [{ id: "fake", input: ["text", "image"], contextWindow: 200_000, maxTokens: 1_000 }, { id: "other" }] });
  provider.setResponses(responses);
  registerPiProvider(provider.provider);
  setApiKeyCredential(provider.provider.id, "test-key");
  const state = createServerState();
  const project = createProject(name, "/tmp/node-commands");
  const source = internalSource(project.id);
  createSession("s", project.id, { agentRuntimeType: "pi", sourceId: source.id, storageOwner: "internal-node" });
  const target = executionTargetFor(state, { id: "s", storage_owner: "internal-node" });
  const model = { provider: provider.provider.id, modelId: "fake" };
  const provision: NodeCommand = { op: "session.provision", sessionId: "s", sourceId: source.id, configuration: { model, thinkingLevel: null, task: null } };
  // Settled runs as the server applied them from the node's durable lifecycle reports.
  const settled = () => db.query<{ n: number }, []>("SELECT COALESCE(MAX(settlement_count), 0) n FROM node_session_watermarks WHERE session_id = 's'").get()!.n;
  // Runs the model answered, as replicated to the server: a duplicate admission would add one.
  const replies = () => db.query<{ n: number }, []>("SELECT COUNT(*) n FROM session_messages WHERE session_id = 's' AND role = 'assistant'").get()!.n;
  const untilSettled = async (runs: number) => { for (let i = 0; i < 400 && settled() < runs; i++) await Bun.sleep(5); expect(settled()).toBe(runs); };
  // Inputs Pi holds for a client ID in the node's canonical transcript.
  const inputs = (clientId: string) => nodeDb.query<{ n: number }, [string]>("SELECT COUNT(*) n FROM session_messages WHERE session_id = 's' AND message_json LIKE ?").get(`%"reinsId":"${clientId}"%`)!.n;
  const dispose = () => { stopInternalNode(state); unregisterPiProvider(provider.provider.id); setNodeDb(); nodeDb.close(); setDb(new Database(":memory:")); db.close(); };
  return { db, nodeDb, state, project, source, target, model, provider, provision, settled, untilSettled, inputs, replies, dispose };
}

const text = (value: string) => [{ type: "text" as const, text: value }];

test("prompt with an image reference, steer, setModel, abort and resumePending cross the internal link; the prompt's attachment.fetch re-enters the same link", async () => {
  const contexts: string[] = [];
  const { db, nodeDb, state, target, provider, provision, untilSettled, inputs, dispose } = nodeSession("wire-commands", [
    context => { contexts.push(JSON.stringify(context.messages)); return fauxAssistantMessage("Seen"); }, fauxAssistantMessage("Steered"),
  ]);
  const node = internalNodeFor(state);
  const send = spyOn(node, "send");
  try {
    expect(await target.send(provision, "provision")).toEqual({ ok: true, value: { kind: "provisioned" } });
    const stored = storeSessionAttachment("s", { data: new Uint8Array([1, 2, 3]), mimeType: "image/png" });
    const image = { type: "image" as const, attachmentId: stored.id, mimeType: "image/png" as const, byteSize: 3, sha256: stored.sha256 };
    const prompt: NodeCommand = { op: "session.prompt", sessionId: "s", clientId: "p1", content: [...text("Look"), image], sourceSessionId: null };
    // The node serves session.prompt by calling attachment.fetch back over the same link before admission.
    expect(await target.send(prompt, "prompt-1")).toEqual({ ok: true, value: { kind: "admitted", inputId: "p1" } });
    expect(nodeDb.query("SELECT data FROM node_attachments WHERE attachment_id = ?").get(stored.id)).toEqual({ data: Buffer.from([1, 2, 3]) });
    await untilSettled(1);
    // The node hydrated the reference for the provider from its cache.
    expect(contexts[0]).toContain(Buffer.from([1, 2, 3]).toString("base64"));

    expect(await target.send({ op: "session.steer", sessionId: "s", clientId: "s1", content: text("And then?") }, "steer-1"))
      .toEqual({ ok: true, value: { kind: "admitted", inputId: "s1" } });
    await untilSettled(2);
    expect([inputs("p1"), inputs("s1")]).toEqual([1, 1]);

    expect(await target.send({ op: "session.setModel", sessionId: "s", provider: provider.provider.id, modelId: "other", thinkingLevel: "high" }, "model-1"))
      .toEqual({ ok: true, value: { kind: "modelSet" } });
    expect(JSON.parse(nodeDb.query<{ value_json: string }, []>("SELECT value_json FROM pi_values WHERE session_id = 's' AND namespace = 'pi.lane.config'").get()!.value_json))
      .toMatchObject({ model: { provider: provider.provider.id, modelId: "other" }, thinkingLevel: "high" });

    // Nothing is running: abort reports so without starting anything; there is no pending operation to resume.
    expect(await target.send({ op: "session.abort", sessionId: "s" })).toEqual({ ok: true, value: { kind: "aborted", aborted: false } });
    expect(await target.send({ op: "session.resumePending", sessionId: "s" }))
      .toEqual({ ok: false, error: { code: "internal", message: "Lane 'main' has no pending inactive operation", retryable: false } });
    // Every command reached the node through its wire handler.
    expect(send.mock.calls.map(([command]) => command.op)).toEqual([
      "session.provision", "session.prompt", "session.steer", "session.setModel", "session.abort", "session.resumePending",
    ]);
    expect(getSession("s")?.storage_owner).toBe("internal-node");
    expect(db.query("SELECT COUNT(*) n FROM node_command_outbox").get()).toEqual({ n: 0 });
  } finally { send.mockRestore(); dispose(); }
}, 15_000);

test("abort of a running node run crosses the link and stops it", async () => {
  let started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  const { target, provision, untilSettled, db, dispose } = nodeSession("wire-abort", [
    (_context, options) => new Promise(resolve => {
      started();
      options?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("stopped", { stopReason: "aborted" })), { once: true });
    }),
  ]);
  try {
    await target.send(provision, "provision");
    expect(await target.send({ op: "session.prompt", sessionId: "s", clientId: "long", content: text("Work") }, "long")).toMatchObject({ ok: true });
    await running;
    expect(await target.send({ op: "session.abort", sessionId: "s" })).toEqual({ ok: true, value: { kind: "aborted", aborted: true } });
    await untilSettled(1);
    expect(db.query("SELECT settlement_json FROM node_session_watermarks WHERE session_id = 's'").get()).toMatchObject({ settlement_json: expect.stringContaining('"status":"aborted"') });
  } finally { dispose(); }
}, 15_000);

test("node rejections keep their NodeResult codes across the wire; values the wire schema rejects never reach the node", async () => {
  const { target, provision, nodeDb, project, source, dispose } = nodeSession("wire-errors");
  const inputRows = () => nodeDb.query("SELECT COUNT(*) n FROM session_messages WHERE role = 'reinsInput'").get();
  try {
    // A node-owned session whose node data is missing (never provisioned on this node).
    createSession("lost", project.id, { agentRuntimeType: "pi", sourceId: source.id, storageOwner: "internal-node" });
    const notFound = { code: "not_found" as const, message: "This session's node data is missing. Start a new session.", retryable: false };
    // Immediate controls report it; submitted work re-hydrates the session first (session-relocation tests).
    expect(await target.send({ op: "session.abort", sessionId: "lost" })).toEqual({ ok: false, error: notFound });
    expect(await target.send({ op: "session.resumePending", sessionId: "lost" })).toEqual({ ok: false, error: notFound });

    await target.send(provision, "provision");
    const missing = { type: "image" as const, attachmentId: "att_missing", mimeType: "image/png" as const, byteSize: 3 };
    expect(await target.send({ op: "session.steer", sessionId: "s", clientId: "bad", content: [missing] }, "bad-image"))
      .toEqual({ ok: false, error: { code: "invalid_request", message: "Attachment unavailable: att_missing", retryable: false } });
    expect(inputRows()).toEqual({ n: 0 });
    expect(await target.send({ op: "session.setModel", sessionId: "s", provider: "nope", modelId: "m" }, "bad-model"))
      .toEqual({ ok: false, error: { code: "invalid_request", message: "Model not found: nope/m", retryable: false } });
    // Inline image bytes are not an attachment reference: invalid params, a terminal delivery exception.
    const inline = { ...missing, data: "AAAA" };
    await expect(target.send({ op: "session.prompt", sessionId: "s", clientId: "inline", content: [inline] }, "inline")).rejects.toMatchObject({ code: -32602 });
    // Submitted work needs its outbox command ID.
    expect(() => target.send({ op: "session.prompt", sessionId: "s", clientId: "no-id", content: text("hi") })).toThrow("session.prompt requires an outbox command ID");
  } finally { dispose(); }
});

test("immediate controls fail to their caller when the link is lost or the call times out; they are never requeued", async () => {
  const { state, provision, target, dispose } = nodeSession("wire-controls");
  try {
    await target.send(provision, "provision");
    const node = internalNodeFor(state);
    spyOn(node, "send").mockReturnValue(new Promise(() => {}));
    const slow = internalNodeExecutionTarget(state, { ...NODE_COMMAND_TIMEOUTS, abort: 5 });
    expect(await slow.send({ op: "session.abort", sessionId: "s" })).toEqual({ ok: false, error: {
      code: "unavailable", message: "Node unavailable: Call timed out after 5ms; outcome unknown", retryable: true } });
    const pending = target.send({ op: "session.resumePending", sessionId: "s" });
    await Bun.sleep(1);
    stopInternalNode(state);
    expect(await pending).toEqual({ ok: false, error: { code: "unavailable", message: "Node unavailable: Connection closed; outcome unknown", retryable: true } });
  } finally { dispose(); }
});

test("a prompt or setModel whose outcome is unknown is requeued, and its replay converges without a second admission", async () => {
  const { nodeDb, state, provision, target, untilSettled, inputs, replies, provider, dispose } = nodeSession("wire-unknown", [fauxAssistantMessage("Once")]);
  const lane = () => JSON.parse(nodeDb.query<{ value_json: string }, []>("SELECT value_json FROM pi_values WHERE session_id = 's' AND namespace = 'pi.lane.config'").get()!.value_json);
  try {
    await target.send(provision, "provision");
    // Admission outlasts the call: the reply is lost but the node admits.
    const node = internalNodeFor(state);
    const admit = node.send.bind(node);
    const slow = spyOn(node, "send").mockImplementation(async (...args) => { await Bun.sleep(30); return admit(...args); });
    const hasty = internalNodeExecutionTarget(state, { ...NODE_COMMAND_TIMEOUTS, input: 5, setModel: 5 });
    const id = enqueueInput("s", "prompt", text("Once"), "once");
    const command = getWork(id)!.command!;
    await deliverCommand(id, () => hasty.send(command, id));
    expect(getWork(id)?.state).toBe("queued");
    for (let i = 0; i < 200 && inputs("once") === 0; i++) await Bun.sleep(5);
    // The replay is recognized by Pi's durable input ID and answered.
    await new NodeCommandDispatcher(state).drain();
    expect(getWork(id)?.state).toBe("admitted");
    await untilSettled(1);
    expect(inputs("once")).toBe(1);

    const setModel: NodeCommand = { op: "session.setModel", sessionId: "s", provider: provider.provider.id, modelId: "other" };
    await expect(hasty.send(setModel, "model")).rejects.toBeInstanceOf(DeliveryDeferred);
    for (let i = 0; i < 200 && lane().model.modelId !== "other"; i++) await Bun.sleep(5);
    slow.mockRestore();
    // The replay applies the same absolute selection again.
    expect(await target.send(setModel, "model")).toEqual({ ok: true, value: { kind: "modelSet" } });
    expect(lane()).toMatchObject({ model: { provider: provider.provider.id, modelId: "other" } });
    expect(replies()).toBe(1);
  } finally { dispose(); }
}, 15_000);

test("crash window: Pi admitted a prompt or steer but the server never learned it; the replay is recognized by Pi and admits nothing twice", async () => {
  const { state, provision, target, untilSettled, inputs, replies, dispose } = nodeSession("wire-crash", [fauxAssistantMessage("First"), fauxAssistantMessage("Second")]);
  try {
    await target.send(provision, "provision");
    const { binding } = provisionForSession("s");
    const node = internalNodeFor(state);
    for (const [op, clientId, runs] of [["prompt", "crashed-prompt", 1], ["steer", "crashed-steer", 2]] as const) {
      const id = enqueueInput("s", op, text(clientId), clientId);
      const command = getWork(id)!.command!;
      // Admission the server never heard of: what a node crash right after Pi admission leaves.
      expect(await node.send(command, binding)).toMatchObject({ ok: true });
      await untilSettled(runs);
      // The server never learned the outcome and replays the stored command over the wire.
      await new NodeCommandDispatcher(state).drain();
      expect(getWork(id)?.state).toBe("admitted");
      await Bun.sleep(50);
      expect(inputs(clientId)).toBe(1);
      expect(replies()).toBe(runs);
    }
  } finally { dispose(); }
}, 15_000);

test("crash window while queued: a steer Pi holds in its queue behind a running run is recognized on replay", async () => {
  let release!: () => void;
  let started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  const { state, provision, target, untilSettled, inputs, dispose } = nodeSession("wire-queued", [
    () => new Promise(resolve => { started(); release = () => resolve(fauxAssistantMessage("Released")); }),
    fauxAssistantMessage("After steer"),
  ]);
  try {
    await target.send(provision, "provision");
    expect(await target.send({ op: "session.prompt", sessionId: "s", clientId: "block", content: text("Work") }, "block")).toMatchObject({ ok: true });
    await running;
    const id = enqueueInput("s", "steer", text("queued"), "queued");
    expect(await internalNodeFor(state).send(getWork(id)!.command!, provisionForSession("s").binding)).toMatchObject({ ok: true });
    // Replayed while Pi still holds the steer in its queue (not yet a transcript entry).
    await new NodeCommandDispatcher(state).drain();
    expect(getWork(id)?.state).toBe("admitted");
    release();
    await untilSettled(1);
    expect(inputs("queued")).toBe(1);
  } finally { dispose(); }
}, 15_000);

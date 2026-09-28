import { test, expect, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { fauxAssistantMessage, fauxProvider, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { NodeCommand } from "@reins/node/contract";
import type { Node } from "@reins/node/node";
import { openNodeDb, type NodeSessionBinding } from "@reins/node/storage";
import { getDb, setDb } from "../../db.js";
import { replicaInput } from "../../node-replica.js";
import { runMigrations } from "../../migrations.js";
import { createProject } from "../../project-store.js";
import { createSource, defaultSource } from "../../node-store.js";
import { createSession, getSession } from "../../session-store.js";
import { storeSessionAttachment } from "../../session-attachments-store.js";
import { commandHeader, enqueueInput, getCommand, pendingInputs } from "../../node-command-store.js";
import { getNodeCommand } from "../../node-command-store.js";
import { deliverCommand, DeliveryDeferred } from "../../models/node-command-delivery.js";
import { commitPlacement } from "../../models/session-ownership.js";
import { selectCreationSource, sessionBinding } from "../../runtimes/node-source.js";
import { createNewSession } from "../../runtimes/session-manager.js";
import { directLink, drainCommands, loopbackLink, loopbackNodeFor, stopLoopbackNode } from "../helpers/loopback-node.js";
import { setTestNodeDb } from "../helpers/test-db.js";
import { NODE_COMMAND_TIMEOUTS, sendNodeCommand } from "../../node-transport/commands.js";
import { registerPiProvider, unregisterPiProvider } from "../../runtimes/pi/factory.js";
import { setApiKeyCredential } from "../../auth-credentials-store.js";
import { createServerState } from "../helpers/server-state.js";
import { Sessions } from "../../models/sessions.js";
import { executeSessionCommand } from "../../runtimes/node-execution.js";

/** A node-owned session on the seeded node's loopback link, with a faux model whose replies the test scripts. */
async function nodeSession(name: string, responses: FauxResponseStep[] = []) {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON"); setDb(db); runMigrations(db);
  const nodeDb = openNodeDb(":memory:");
  setTestNodeDb(nodeDb);
  const provider = fauxProvider({ provider: name, models: [{ id: "fake", input: ["text", "image"], contextWindow: 200_000, maxTokens: 1_000 }, { id: "other" }] });
  provider.setResponses(responses);
  registerPiProvider(provider.provider);
  setApiKeyCredential(provider.provider.id, "test-key");
  const state = createServerState(undefined, { loopbackNode: true });
  const project = createProject(name, "/tmp/node-commands");
  const source = defaultSource(project.id)!;
  createSession("s", project.id, { agentRuntimeType: "pi", sourceId: source.id, placementStatus: "provisioned" });
  await loopbackLink(state).ready();
  const target = state.nodes;
  const model = { provider: provider.provider.id, modelId: "fake" };
  const provision: NodeCommand = { op: "session.provision", sessionId: "s", sourceId: source.id, configuration: { model, thinkingLevel: null, task: null } };
  // Settled runs as the server applied them from the node's durable lifecycle reports.
  const settled = () => db.query<{ n: number }, []>("SELECT COALESCE(MAX(settlement_count), 0) n FROM node_session_watermarks WHERE session_id = 's'").get()!.n;
  // Runs the model answered, as replicated to the server: a duplicate admission would add one.
  const replies = () => db.query<{ n: number }, []>("SELECT COUNT(*) n FROM session_messages WHERE session_id = 's' AND role = 'assistant'").get()!.n;
  const untilSettled = async (runs: number) => { for (let i = 0; i < 400 && settled() < runs; i++) await Bun.sleep(5); expect(settled()).toBe(runs); };
  // Inputs Pi holds for a client ID in the node's canonical transcript.
  const inputs = (clientId: string) => nodeDb.query<{ n: number }, [string]>("SELECT COUNT(*) n FROM session_messages WHERE session_id = 's' AND message_json LIKE ?").get(`%"reinsId":"${clientId}"%`)!.n;
  const dispose = async () => { await stopLoopbackNode(state); unregisterPiProvider(provider.provider.id); setTestNodeDb(); nodeDb.close(); setDb(new Database(":memory:")); db.close(); };
  return { db, nodeDb, state, project, source, target, model, provider, provision, settled, untilSettled, inputs, replies, dispose };
}

const text = (value: string) => [{ type: "text" as const, text: value }];
/** Admits a stored prompt/steer on the node directly, as a node crash right after Pi admission leaves it. */
const admitDirectly = (node: Node, command: NodeCommand, binding: NodeSessionBinding) => {
  if (command.op !== "session.prompt" && command.op !== "session.steer") throw new Error(`Not an input: ${command.op}`);
  const input = { sessionId: command.sessionId, binding, clientId: command.clientId, content: command.content, sourceSessionId: command.sourceSessionId };
  return command.op === "session.prompt" ? node.prompt(input) : node.steer(input);
};

test("prompt with an image reference, steer, setModel, abort and resumePending cross the node link; the prompt's attachment.fetch re-enters the same link", async () => {
  const contexts: string[] = [];
  const { db, nodeDb, state, target, provider, provision, untilSettled, inputs, dispose } = await nodeSession("wire-commands", [
    context => { contexts.push(JSON.stringify(context.messages)); return fauxAssistantMessage("Seen"); }, fauxAssistantMessage("Steered"),
  ]);
  const node = loopbackNodeFor(state);
  const served = (["provision", "prompt", "steer", "setModel", "abort", "resumePending"] as const).map(method => spyOn(node, method));
  try {
    expect(await target.send(provision)).toEqual({ ok: true, value: { kind: "provisioned" } });
    const stored = storeSessionAttachment("s", { data: new Uint8Array([1, 2, 3]), mimeType: "image/png" });
    const image = { type: "image" as const, attachmentId: stored.id, mimeType: "image/png" as const, byteSize: 3, sha256: stored.sha256 };
    const prompt: NodeCommand = { op: "session.prompt", sessionId: "s", clientId: "p1", content: [...text("Look"), image], sourceSessionId: null };
    // The node serves session.prompt by calling attachment.fetch back over the same link before admission.
    expect(await target.send(prompt)).toEqual({ ok: true, value: { kind: "admitted", inputId: "p1" } });
    expect(nodeDb.query("SELECT data FROM node_attachments WHERE attachment_id = ?").get(stored.id)).toEqual({ data: Buffer.from([1, 2, 3]) });
    await untilSettled(1);
    // The node hydrated the reference for the provider from its cache.
    expect(contexts[0]).toContain(Buffer.from([1, 2, 3]).toString("base64"));

    expect(await target.send({ op: "session.steer", sessionId: "s", clientId: "s1", content: text("And then?"), sourceSessionId: null }))
      .toEqual({ ok: true, value: { kind: "admitted", inputId: "s1" } });
    await untilSettled(2);
    expect([inputs("p1"), inputs("s1")]).toEqual([1, 1]);

    expect(await target.send({ op: "session.setModel", sessionId: "s", provider: provider.provider.id, modelId: "other", thinkingLevel: "high" }))
      .toEqual({ ok: true, value: { kind: "modelSet" } });
    expect(JSON.parse(nodeDb.query<{ value_json: string }, []>("SELECT value_json FROM pi_values WHERE session_id = 's' AND namespace = 'pi.lane.config'").get()!.value_json))
      .toMatchObject({ model: { provider: provider.provider.id, modelId: "other" }, thinkingLevel: "high" });

    // Nothing is running: abort reports so without starting anything; there is no pending operation to resume.
    expect(await target.send({ op: "session.abort", sessionId: "s" })).toEqual({ ok: true, value: { kind: "aborted", aborted: false } });
    expect(await target.send({ op: "session.resumePending", sessionId: "s" }))
      .toEqual({ ok: false, error: { code: "internal", message: "Lane 'main' has no pending inactive operation", retryable: false } });
    // Every command reached the node through its own wire handler, once.
    expect(served.map(spy => spy.mock.calls.length)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(getSession("s")?.placement_status).toBe("provisioned");
    expect(db.query("SELECT COUNT(*) n FROM node_command_outbox").get()).toEqual({ n: 0 });
  } finally { for (const spy of served) spy.mockRestore(); await dispose(); }
}, 15_000);

test("a provisioned session runs its input from its placement alone, with no settled outbox record, and the delivered input leaves the outbox", async () => {
  const { db, state, target, provision, untilSettled, replies, dispose } = await nodeSession("legacy-provision", [fauxAssistantMessage("Hello")]);
  try {
    expect(await target.send(provision)).toEqual({ ok: true, value: { kind: "provisioned" } });
    expect(db.query("SELECT COUNT(*) n FROM node_command_outbox").get()).toEqual({ n: 0 });
    expect(new Sessions(state.nodes).get("s")?.placement).toEqual({ status: "provisioned", error: null, available: true, nodeId: "internal", nodeName: "Internal" });
    await executeSessionCommand(state, "s", "prompt", text("Hi"), "c1");
    await untilSettled(1);
    expect(replies()).toBe(1);
    expect(db.query("SELECT COUNT(*) n FROM node_command_outbox").get()).toEqual({ n: 0 });
    expect(replicaInput(db, "s", "c1")).toMatchObject({ seq: expect.any(Number) });
    // A replay of the admitted input is recognized from the replica and queues nothing.
    await executeSessionCommand(state, "s", "prompt", text("Hi"), "c1");
    expect(db.query("SELECT COUNT(*) n FROM node_command_outbox").get()).toEqual({ n: 0 });
  } finally { await dispose(); }
}, 15_000);

test("abort of a running node run crosses the link and stops it", async () => {
  let started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  const { target, provision, untilSettled, db, dispose } = await nodeSession("wire-abort", [
    (_context, options) => new Promise(resolve => {
      started();
      options?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("stopped", { stopReason: "aborted" })), { once: true });
    }),
  ]);
  try {
    await target.send(provision);
    expect(await target.send({ op: "session.prompt", sessionId: "s", clientId: "long", content: text("Work"), sourceSessionId: null })).toMatchObject({ ok: true });
    await running;
    expect(await target.send({ op: "session.abort", sessionId: "s" })).toEqual({ ok: true, value: { kind: "aborted", aborted: true } });
    await untilSettled(1);
    expect(db.query("SELECT settlement_json FROM node_session_watermarks WHERE session_id = 's'").get()).toMatchObject({ settlement_json: expect.stringContaining('"status":"aborted"') });
  } finally { await dispose(); }
}, 15_000);

test("node rejections keep their NodeResult codes across the wire; values the wire schema rejects never reach the node", async () => {
  const { target, provision, nodeDb, project, source, dispose } = await nodeSession("wire-errors");
  const inputRows = () => nodeDb.query("SELECT COUNT(*) n FROM session_messages WHERE role = 'reinsInput'").get();
  try {
    // A node-owned session whose node data is missing (never provisioned on this node).
    createSession("lost", project.id, { agentRuntimeType: "pi", sourceId: source.id, placementStatus: "provisioned" });
    const notFound = { code: "not_found" as const, message: "This session's node data is missing. Start a new session.", retryable: false };
    // Immediate controls report it; submitted work re-hydrates the session first (session-relocation tests).
    expect(await target.send({ op: "session.abort", sessionId: "lost" })).toEqual({ ok: false, error: notFound });
    expect(await target.send({ op: "session.resumePending", sessionId: "lost" })).toEqual({ ok: false, error: notFound });

    await target.send(provision);
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
  const { state, provision, target, dispose } = await nodeSession("wire-controls");
  try {
    await target.send(provision);
    const node = loopbackNodeFor(state);
    spyOn(node, "abort").mockReturnValue(new Promise(() => {}));
    spyOn(node, "resumePending").mockReturnValue(new Promise(() => {}));
    // Over a link whose abort bound is 5ms.
    const link = await directLink(state, node);
    expect(await sendNodeCommand(link, { op: "session.abort", sessionId: "s" }, sessionBinding("s").binding, { ...NODE_COMMAND_TIMEOUTS, abort: 5 })).toEqual({ ok: false, error: {
      code: "unavailable", message: "Node unavailable: Call timed out after 5ms; outcome unknown", retryable: true } });
    const pending = target.send({ op: "session.resumePending", sessionId: "s" });
    await Bun.sleep(1);
    await stopLoopbackNode(state);
    expect(await pending).toEqual({ ok: false, error: { code: "unavailable", message: "Node unavailable: Connection closed; outcome unknown", retryable: true } });
  } finally { await dispose(); }
});

test("a prompt or setModel whose outcome is unknown is requeued, and its replay converges without a second admission", async () => {
  const { nodeDb, state, provision, target, untilSettled, inputs, replies, provider, dispose } = await nodeSession("wire-unknown", [fauxAssistantMessage("Once")]);
  const lane = () => JSON.parse(nodeDb.query<{ value_json: string }, []>("SELECT value_json FROM pi_values WHERE session_id = 's' AND namespace = 'pi.lane.config'").get()!.value_json);
  try {
    await target.send(provision);
    // Admission outlasts the call: the reply is lost but the node admits.
    const node = loopbackNodeFor(state);
    const [admit, apply] = [node.prompt.bind(node), node.setModel.bind(node)];
    const slow = [
      spyOn(node, "prompt").mockImplementation(async input => { await Bun.sleep(30); return admit(input); }),
      spyOn(node, "setModel").mockImplementation(async input => { await Bun.sleep(30); return apply(input); }),
    ];
    // Sent over a link whose input and setModel bounds are 5ms.
    const link = await directLink(state, node);
    const hasty = (command: NodeCommand) => sendNodeCommand(link, command, sessionBinding("s").binding, { ...NODE_COMMAND_TIMEOUTS, input: 5, setModel: 5 });
    const id = enqueueInput("s", "prompt", text("Once"), "once")!;
    const command = getNodeCommand(id)!.command!;
    await deliverCommand(id, () => hasty(command), result => commitPlacement("s", commandHeader(getCommand(id)!.command_json), result));
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
    expect(await target.send(setModel)).toEqual({ ok: true, value: { kind: "modelSet" } });
    expect(lane()).toMatchObject({ model: { provider: provider.provider.id, modelId: "other" } });
    expect(replies()).toBe(1);
  } finally { await dispose(); }
}, 15_000);

test("crash window: Pi admitted a prompt or steer but the server never learned it; the replay is recognized by Pi and admits nothing twice", async () => {
  const { state, provision, target, untilSettled, inputs, replies, dispose } = await nodeSession("wire-crash", [fauxAssistantMessage("First"), fauxAssistantMessage("Second")]);
  try {
    await target.send(provision);
    const { binding } = sessionBinding("s");
    const node = loopbackNodeFor(state);
    for (const [op, clientId, runs] of [["prompt", "crashed-prompt", 1], ["steer", "crashed-steer", 2]] as const) {
      const id = enqueueInput("s", op, text(clientId), clientId)!;
      const command = getNodeCommand(id)!.command!;
      // Admission the server never heard of: what a node crash right after Pi admission leaves.
      expect(await admitDirectly(node, command, binding)).toEqual({ inputId: clientId });
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

test("crash window while queued: a steer Pi holds in its queue behind a running run is recognized on replay", async () => {
  let release!: () => void;
  let started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  const { state, provision, target, untilSettled, inputs, dispose } = await nodeSession("wire-queued", [
    () => new Promise(resolve => { started(); release = () => resolve(fauxAssistantMessage("Released")); }),
    fauxAssistantMessage("After steer"),
  ]);
  try {
    await target.send(provision);
    expect(await target.send({ op: "session.prompt", sessionId: "s", clientId: "block", content: text("Work"), sourceSessionId: null })).toMatchObject({ ok: true });
    await running;
    const id = enqueueInput("s", "steer", text("queued"), "queued")!;
    expect(await admitDirectly(loopbackNodeFor(state), getNodeCommand(id)!.command!, sessionBinding("s").binding)).toEqual({ inputId: "queued" });
    // The replica already proves the admission: Pi's pending steering entry replicated before the reply.
    expect(replicaInput(getDb(), "s", "queued")).toEqual({ queued: true });
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
    // Queued behind its provisioning until the remote node connects, not rejected.
    await executeSessionCommand(state, far.id, "steer", text("hi"), "c");
    expect(pendingInputs(far.id)).toEqual([{ id: expect.any(String), clientId: "c" }]);
  } finally { setDb(new Database(":memory:")); db.close(); }
});

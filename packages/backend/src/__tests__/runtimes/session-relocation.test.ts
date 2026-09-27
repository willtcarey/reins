import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory, type FauxResponseStep } from "@earendil-works/pi-ai";
import { laneConfig } from "@earendil-works/pi-agent-core";
import { startNode, type Node } from "@reins/node/node";
import { connectNode } from "@reins/node/node-connection";
import { createLoopbackPair, RpcFailure } from "@reins/node/protocol";
import { piSnapshotSummary, samePiSnapshot } from "@reins/node/pi-storage";
import { getDb } from "../../db.js";
import { setApiKeyCredential } from "../../auth-credentials-store.js";
import { createProject } from "../../project-store.js";
import { createSource, internalSource } from "../../node-store.js";
import { createSession, getSession } from "../session-fixture.js";
import { storeSessionAttachment } from "../../session-attachments-store.js";
import { enqueueInput, enqueueSetModel, getCommand } from "../../node-command-store.js";
import { dispatcherFor, type NodeCommandDispatcher } from "../../models/node-command-dispatcher.js";
import { deliverCommand, DeliveryDeferred } from "../../models/node-command-transport.js";
import { commitPlacement, requestSessionMove } from "../../models/session-ownership.js";
import { getWork } from "../../models/node-command-projection.js";
import { executeSessionCommand } from "../../runtimes/node-execution.js";
import { internalNodeExecutionTarget } from "../../runtimes/internal-node-execution.js";
import { createServerTransport } from "../../node-transport/server-peer.js";
import { internalNodeServer, setInternalNodeConnectorForTesting, closeInternalNodeLink, type InternalLink } from "../../runtimes/internal-node.js";
import { NODE_COMMAND_TIMEOUTS } from "../../node-transport/commands.js";
import { createPiContext, registerPiProvider, unregisterPiProvider } from "../../runtimes/pi/factory.js";
import { createAgentHarnessPiRuntime } from "@reins/node/pi-runtime";
import { createHostTools } from "@reins/node/host-tools";
import { createReinsTools } from "@reins/node/reins-tools";
import { serverToolCalls, sessionToolScope } from "../../tools/index.js";
import { hydratePromptContent } from "../../session-attachments-store.js";
import { createNewSession } from "../../runtimes/session-manager.js";
import { loadMessages } from "../../messages-store.js";
import { createServerState } from "../helpers/server-state.js";
import { setupTestDb, teardownTestDb, testNodeDb } from "../helpers/test-db.js";
import type { ServerHandlers } from "../../node-transport/server-peer.js";
import type { ServerState } from "../../state.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const text = (value: string) => [{ type: "text" as const, text: value }];

type Rows = Array<{ seq: number; harness_id: string; role: string; message_json: string }>;
const entries = (db: Database, sessionId: string): Rows => db.query<Rows[number], [string]>(
  "SELECT seq, harness_id, role, message_json FROM session_messages WHERE session_id = ? ORDER BY seq").all(sessionId);
const laneValue = (db: Database, sessionId: string) => {
  const address = laneConfig("main");
  const row = db.query<{ value_json: string }, [string, string, string]>("SELECT value_json FROM pi_values WHERE session_id = ? AND namespace = ? AND key = ?")
    .get(sessionId, address.namespace, address.key);
  return row ? JSON.parse(row.value_json) : null;
};
const settledRuns = (sessionId: string) => getDb().query<{ n: number }, [string]>(
  "SELECT COALESCE(MAX(settlement_count), 0) n FROM node_session_watermarks WHERE session_id = ?").get(sessionId)!.n;
async function until(condition: () => boolean, message = "condition"): Promise<void> {
  for (let i = 0; i < 600 && !condition(); i++) await Bun.sleep(5);
  if (!condition()) throw new Error(`Timed out waiting for ${message}`);
}
const moves = (sessionId: string) => getDb().query<{ op: string; state: string }, [string]>(
  "SELECT json_extract(command_json, '$.op') op, state FROM node_command_outbox WHERE session_id = ? AND json_extract(command_json, '$.op') = 'session.hydrate' ORDER BY rowid").all(sessionId);
const hydrateCommand = (id: string) => {
  const command = getWork(id)!.command!;
  if (command.op !== "session.hydrate") throw new Error(`Not a hydrate: ${command.op}`);
  return command;
};
/** Stands in for another node acknowledging the session's queued hydrate (tests reach only the internal node). */
const acknowledgeOn = (sessionId: string) => {
  const id = getDb().query<{ id: string }, [string]>(
    "SELECT id FROM node_command_outbox WHERE session_id = ? AND json_extract(command_json, '$.op') = 'session.hydrate' AND state = 'queued'").get(sessionId)!.id;
  return deliverCommand(id, async () => ({ ok: true, value: { kind: "hydrated" } }), result => commitPlacement(sessionId, getCommand(id)!.command_json, result));
};
/** Stands in for a node rejecting the session's queued hydrate. */
const rejectOn = (sessionId: string, message: string) => {
  const id = getDb().query<{ id: string }, [string]>(
    "SELECT id FROM node_command_outbox WHERE session_id = ? AND json_extract(command_json, '$.op') = 'session.hydrate' AND state = 'queued'").get(sessionId)!.id;
  return deliverCommand(id, async () => ({ ok: false, error: { code: "invalid_request", message, retryable: false } }),
    result => commitPlacement(sessionId, getCommand(id)!.command_json, result));
};
/** A second node with a source for the project, which the tests cannot reach: its hydrate stays queued. */
const otherNode = (projectId: number) => {
  getDb().query("INSERT INTO nodes (id, name) VALUES ('other', 'Other')").run();
  return createSource(projectId, "other", "/elsewhere");
};

/**
 * A node on an in-memory link whose server handlers the test can wrap (to lose a connection mid-pull
 * or corrupt a page) and that can be restarted over the same node database, as a node process would.
 */
function wrappableNode(state: ServerState, wrap: (handlers: ServerHandlers, link: () => InternalLink) => ServerHandlers = handlers => handlers) {
  let node: Node | undefined;
  let current: InternalLink | undefined;
  const connect = (): InternalLink => {
    node ??= startNode(testNodeDb());
    const [serverEnd, nodeEnd] = createLoopbackPair();
    const uncapped = { maxFrameBytes: Infinity };
    const server = createServerTransport(serverEnd, wrap(internalNodeServer(state), () => current!), uncapped);
    const connection = connectNode(node, nodeEnd, "internal", uncapped);
    serverEnd.onmessage = server.receive; serverEnd.onclose = server.close;
    nodeEnd.onmessage = connection.receive; nodeEnd.onclose = connection.close;
    const ready = connection.ready.catch((error: unknown) => { throw new RpcFailure("unavailable", String(error)); });
    ready.catch(() => undefined);
    current = { closed: () => serverEnd.closed, close: () => serverEnd.close(), async client() { await ready; return server; } };
    return current;
  };
  setInternalNodeConnectorForTesting(state, connect);
  return {
    get node() { return node!; },
    /** The connection drops and the same node redials now (attaching replays its pending reports). */
    relink() { closeInternalNodeLink(state); setInternalNodeConnectorForTesting(state, connect, { linkNow: true }); },
    /** The node process stops: its connection closes and a new instance starts on the next command. */
    async restart() { closeInternalNodeLink(state); const stopped = node; node = undefined; await stopped?.shutdown(); },
    async stop() { closeInternalNodeLink(state); const stopped = node; node = undefined; await stopped?.shutdown(); },
  };
}

describe("session relocation", () => {
  let nodeDb: Database;
  let dir: string;
  let providerId: string;
  let responses: FauxResponseStep[];
  let contexts: string[];
  /** The model and reasoning level of every provider request. */
  let requests: Array<{ model: string; reasoning: unknown }>;
  let state: ServerState;
  let dispatcher: NodeCommandDispatcher;

  beforeEach(() => {
    setupTestDb();
    nodeDb = testNodeDb();
    dir = mkdtempSync(join(tmpdir(), "reins-relocation-"));
    writeFileSync(join(dir, "pixel.png"), PNG);
    contexts = [];
    requests = [];
    responses = [];
    const provider = fauxProvider({ provider: `relocation-faux-${crypto.randomUUID()}`, models: [{ id: "fake", input: ["text", "image"], contextWindow: 200_000, maxTokens: 1_000 }] });
    const step: FauxResponseFactory = (context, options, providerState, model) => {
      contexts.push(JSON.stringify(context.messages));
      requests.push({ model: model.id, reasoning: options?.reasoning ?? null });
      const next = responses.shift();
      if (!next) throw new Error("No scripted response");
      return typeof next === "function" ? next(context, options, providerState, model) : next;
    };
    provider.setResponses(Array.from({ length: 8 }, () => step));
    providerId = provider.provider.id;
    registerPiProvider(provider.provider);
    setApiKeyCredential(providerId, "test-key");
    state = createServerState(undefined, { loopbackNode: false });
    // The dispatcher input submission wakes, so draining it covers work the test submitted.
    dispatcher = dispatcherFor(state);
  });
  afterEach(() => {
    dispatcher.stop();
    closeInternalNodeLink(state);
    unregisterPiProvider(providerId);
    rmSync(dir, { recursive: true, force: true });
    teardownTestDb();
  });

  /** A session at rest on the server with real history, as the server wrote it when it still ran
   * sessions (Pi over the server's own tables, driven here by the test): a prompt with an image
   * attachment reference, a tool call whose result carries an inline image, usage and Pi's lane (model
   * and thinking level). */
  async function legacySession(sessionId = "legacy") {
    const project = createProject("Relocation", dir);
    const row = createSession(sessionId, project.id, { agentRuntimeType: "pi", sourceId: internalSource(project.id).id, modelProvider: providerId, modelId: "fake", thinkingLevel: "high" });
    const attachment = storeSessionAttachment(sessionId, { data: new Uint8Array(PNG), mimeType: "image/png", filename: "prompt.png" });
    const image = { type: "image" as const, attachmentId: attachment.id, mimeType: "image/png" as const, byteSize: PNG.byteLength, sha256: attachment.sha256 };
    responses.push(fauxAssistantMessage([fauxToolCall("read", { path: "pixel.png" }, { id: "read-1" })], { stopReason: "toolUse" }), fauxAssistantMessage("Seen on the server"));
    const { modelRuntime } = await createPiContext({ cwd: dir });
    // The same tools a node registers, so opening it there changes nothing in its lane.
    const host = createHostTools({ cwd: dir, sessionId, builtins: ["read", "write", "edit", "bash"], sessionEnvironment: { provider: providerId, modelId: "fake", thinkingLevel: "high" } });
    const tools = [...host.tools, ...createReinsTools(serverToolCalls({ ...sessionToolScope(sessionId), sessionId, broadcast: () => {} }))];
    const runtime = await createAgentHarnessPiRuntime({
      db: getDb(), sessionId, createdAt: new Date(row.created_at).getTime(), cwd: dir,
      lifecycle: { started() {}, settled() {} },
      options: { models: modelRuntime, model: modelRuntime.getModel(providerId, "fake")!, thinkingLevel: "high",
        tools, activeToolNames: tools.map(tool => tool.name), toolContext: { env: host.executionEnv } },
      executionEnv: host.executionEnv,
      hydratePrompt: hydratePromptContent,
    });
    await runtime.prompt([...text("Look"), image], { reinsId: "legacy-1" });
    await runtime.waitForIdle();
    await runtime.close();
    expect(getSession(sessionId)?.placement_status).toBe("server");
    return { project, attachment };
  }

  test("a legacy session hydrates onto its node on its next prompt, which runs there with continuous history, its model and its attachments", async () => {
    const { attachment } = await legacySession();
    const before = entries(getDb(), "legacy");
    const summary = piSnapshotSummary(getDb(), "legacy");
    const lane = laneValue(getDb(), "legacy");
    // Real legacy history: a tool call, an inline tool-result image, a prompt image reference, usage.
    expect(before.map(row => row.role)).toEqual(["reinsInput", "assistant", "toolResult", "assistant"]);
    expect(before[2]!.message_json).toContain('"data":"');
    expect(before[0]!.message_json).toContain(attachment.id);
    expect(getDb().query("SELECT COUNT(*) n FROM pi_usage WHERE session_id = 'legacy'").get()).toEqual({ n: 2 });
    expect(lane).toMatchObject({ model: { provider: providerId, modelId: "fake" }, thinkingLevel: "high" });
    const node = wrappableNode(state);
    try {
      responses.push(fauxAssistantMessage("Continued on the node"));
      await executeSessionCommand(state, "legacy", "prompt", text("And now?"), "node-1");
      // The lazy trigger queued the move ahead of the input, and the session is moving in the same transaction.
      expect(getDb().query("SELECT json_extract(command_json, '$.op') op FROM node_command_outbox WHERE session_id = 'legacy' ORDER BY rowid").all())
        .toEqual([{ op: "session.hydrate" }, { op: "session.prompt" }]);
      expect(getSession("legacy")).toMatchObject({ placement_status: "moving" });
      await dispatcher.drain();
      await until(() => settledRuns("legacy") === 1, "the node run to settle");
      await until(() => !nodeDb.query("SELECT 1 FROM session_outbox").get(), "the node outbox to drain");

      // It is on its node from the hydrate's settlement.
      expect(getSession("legacy")).toMatchObject({ placement_status: "provisioned", status_error: null });
      // The outbox is a queue: the delivered move and input are gone.
      expect(getDb().query("SELECT COUNT(*) n FROM node_command_outbox WHERE session_id = 'legacy'").get()).toEqual({ n: 0 });
      // Continuity: the copied rows are verbatim, new entries continue the sequence, nothing is duplicated.
      const after = entries(getDb(), "legacy");
      expect(after.slice(0, before.length)).toEqual(before);
      expect(entries(nodeDb, "legacy")).toEqual(after);
      expect(after.slice(before.length).map(row => row.role)).toEqual(["reinsInput", "assistant"]);
      expect(after.every((row, index) => index === 0 || row.seq > after[index - 1]!.seq)).toBe(true);
      expect(after.slice(before.length)[0]!.seq).toBe(summary.harnessNextSeq);
      expect(new Set(after.map(row => row.harness_id)).size).toBe(after.length);
      expect(loadMessages("legacy").filter(message => message.role === "user").map(message => message.content))
        .toEqual([[...text("Look"), expect.objectContaining({ type: "image", attachmentId: attachment.id })], text("And now?")]);
      expect(samePiSnapshot(piSnapshotSummary(nodeDb, "legacy"), piSnapshotSummary(getDb(), "legacy"))).toBe(true);
      // Model and thinking level came from the copied lane: the node's request matches the server's.
      expect(laneValue(nodeDb, "legacy")).toEqual(lane);
      expect(requests.at(-1)).toEqual(requests[0]!);
      expect(requests[0]).toEqual({ model: "fake", reasoning: "high" });
      // The referenced attachment is in the node cache and both images reached the provider: the
      // historical prompt image from the cache, the tool result's inline image as stored.
      expect(nodeDb.query("SELECT attachment_id FROM node_attachments WHERE session_id = 'legacy'").all()).toEqual([{ attachment_id: attachment.id }]);
      const providerInput = contexts.at(-1)!;
      expect(providerInput.split(PNG.toString("base64")).length - 1).toBe(2);
      expect(providerInput).not.toContain("[Image attachment missing]");
    } finally { await node.stop(); }
  }, 20_000);

  test("hydrate replays converge: a node that dies mid-pull and a lost acknowledgement", async () => {
    await legacySession();
    const summary = piSnapshotSummary(getDb(), "legacy");
    let pages = 0;
    let dieOnFetch = true;
    const node = wrappableNode(state, (handlers, link) => ({
      ...handlers,
      snapshot: async (sessionId, fromSeq) => {
        // The second attempt's pull outlasts its call, so its acknowledgement is lost.
        if (++pages === 2) await Bun.sleep(30);
        return handlers.snapshot(sessionId, fromSeq);
      },
      // The node process dies after pulling the rows, while fetching the attachment they reference.
      attachment: (sessionId, attachmentId) => {
        if (dieOnFetch) { dieOnFetch = false; link().close(); throw new Error("node gone"); }
        return handlers.attachment(sessionId, attachmentId);
      },
    }));
    try {
      expect(requestSessionMove("legacy", "internal")).toEqual({ state: "moving", nodeId: "internal" });
      const id = getDb().query<{ id: string }, []>("SELECT id FROM node_command_outbox WHERE json_extract(command_json, '$.op') = 'session.hydrate'").get()!.id;
      const command = hydrateCommand(id);
      // First attempt: the link closes mid-pull; the outcome is unknown, so the hydrate is requeued and
      // the node stored nothing.
      await deliverCommand(id, () => internalNodeExecutionTarget(state).send(command, id), result => commitPlacement("legacy", getCommand(id)!.command_json, result));
      expect(pages).toBe(1);
      expect(getCommand(id)?.state).toBe("queued");
      expect(nodeDb.query("SELECT 1 FROM sessions WHERE id = 'legacy'").get()).toBeNull();
      expect(getSession("legacy")).toMatchObject({ placement_status: "moving" });
      await node.restart();

      // Second attempt: the node finishes, but its acknowledgement is lost (the call times out).
      const hasty = internalNodeExecutionTarget(state, { ...NODE_COMMAND_TIMEOUTS, hydrate: 1 });
      await expect(hasty.send(command, id)).rejects.toBeInstanceOf(DeliveryDeferred);
      await until(() => !!nodeDb.query("SELECT 1 FROM sessions WHERE id = 'legacy'").get(), "the node to finish hydrating");
      expect(getSession("legacy")?.placement_status).toBe("moving");

      // The node process restarts before the replay, which finds the identical copy by content and is
      // acknowledged at once; the session is placed once.
      await node.restart();
      await dispatcher.drain();
      expect(getCommand(id)).toBeNull();
      expect(pages).toBe(2);
      expect(getSession("legacy")).toMatchObject({ placement_status: "provisioned" });
      expect(samePiSnapshot(piSnapshotSummary(nodeDb, "legacy"), summary)).toBe(true);
    } finally { await node.stop(); }
  }, 20_000);

  test("a copy that does not match its digest is rejected: the session returns to rest on the server with the reason, its history intact, and its input fails", async () => {
    const { project } = await legacySession();
    const history = entries(getDb(), "legacy");
    const events: Array<{ type: string; sessionId?: string; error?: string }> = [];
    state.clients.add({ ws: { send: data => { events.push(JSON.parse(data)); return 0; } } });
    const node = wrappableNode(state, handlers => ({
      ...handlers,
      // A page whose rows differ from the summary the hydrate carries.
      snapshot: async (sessionId, fromSeq) => {
        const page = await handlers.snapshot(sessionId, fromSeq);
        return { ...page, rows: page.rows.map(row => row.table === "entry" && row.role === "assistant" ? { ...row, messageJson: row.messageJson.replace("Seen", "Forged") } : row) };
      },
    }));
    try {
      await executeSessionCommand(state, "legacy", "prompt", text("Again"), "after-forgery");
      await dispatcher.drain();
      // A failed move returns the session to rest on the server, with the reason; its history is untouched.
      expect(getSession("legacy")).toMatchObject({ placement_status: "server",
        status_error: expect.stringContaining("Hydration verification failed") });
      expect(entries(getDb(), "legacy")).toEqual(history);
      expect(loadMessages("legacy").map(message => message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
      expect(nodeDb.query("SELECT 1 FROM sessions WHERE id = 'legacy'").get()).toBeNull();
      expect(moves("legacy")).toEqual([]);
      expect(events).toContainEqual({ type: "error", sessionId: "legacy", error: expect.stringContaining("Session move failed: Hydration verification failed") });
      // The input behind it tried to move the session itself, failed the same way and was removed.
      expect(getDb().query("SELECT 1 FROM node_command_outbox WHERE json_extract(command_json, '$.clientId') = 'after-forgery'").get()).toBeNull();
      expect(project.id).toBeGreaterThan(0);
    } finally { await node.stop(); }
  }, 20_000);

  test("work reaching a session at rest with no move queued ahead hydrates it outside the outbox: its placement follows the outcome", async () => {
    await legacySession();
    let forge = true;
    const node = wrappableNode(state, handlers => ({
      ...handlers,
      snapshot: async (sessionId, fromSeq) => {
        const page = await handlers.snapshot(sessionId, fromSeq);
        return forge ? { ...page, rows: page.rows.map(row => row.table === "entry" && row.role === "assistant" ? { ...row, messageJson: row.messageJson.replace("Seen", "Forged") } : row) } : page;
      },
    }));
    try {
      // Input stored without the lazy trigger (as if its queued move was interrupted by a restart).
      enqueueInput("legacy", "prompt", text("First"), "direct-1");
      await dispatcher.drain();
      expect(getSession("legacy")).toMatchObject({ placement_status: "server",
        status_error: expect.stringContaining("Hydration verification failed") });
      expect(getDb().query("SELECT COUNT(*) n FROM node_command_outbox").get()).toEqual({ n: 0 });

      forge = false;
      responses.push(fauxAssistantMessage("Ran after the move"));
      enqueueInput("legacy", "prompt", text("Second"), "direct-2");
      await dispatcher.drain();
      await until(() => settledRuns("legacy") === 1, "the node run");
      expect(getSession("legacy")).toMatchObject({ placement_status: "provisioned", status_error: null });
      expect(getDb().query("SELECT COUNT(*) n FROM node_command_outbox").get()).toEqual({ n: 0 });
    } finally { await node.stop(); }
  }, 20_000);

  /** A node-owned session that ran once on the internal node, with a prompt image. */
  async function nodeSession(name: string) {
    const project = createProject(name, dir);
    responses.push(fauxAssistantMessage("First on the node"));
    const { id } = createNewSession(state, project.id, dir, { model: { provider: providerId, modelId: "fake" } });
    const attachment = storeSessionAttachment(id, { data: new Uint8Array(PNG), mimeType: "image/png" });
    await executeSessionCommand(state, id, "prompt", [...text("Hello"), { type: "image", attachmentId: attachment.id, mimeType: "image/png", byteSize: PNG.byteLength, sha256: attachment.sha256 }], "first");
    await dispatcher.drain();
    await until(() => settledRuns(id) === 1, "the first run");
    await until(() => !nodeDb.query("SELECT 1 FROM session_outbox").get(), "the node outbox");
    return { project, id, attachment };
  }

  test("moving an idle node-owned session re-points it at once and tells the old node nothing; the old node's late commit is refused (not_owner), dropped with its copy, never retried", async () => {
    let offline = false;
    const refusals: string[] = [];
    const node = wrappableNode(state, handlers => ({
      ...handlers,
      committed: input => {
        if (offline) throw new Error("server unreachable");
        try { return handlers.committed(input); }
        catch (error) { refusals.push(error instanceof RpcFailure ? JSON.stringify(error.data) : String(error)); throw error; }
      },
    }));
    try {
      const { project, id, attachment } = await nodeSession("Move");
      const before = entries(getDb(), id);
      // A commit outside a run (a model change's lane write) that the old node has not delivered when
      // the session moves: the accepted loss of a move.
      offline = true;
      enqueueSetModel(id, { provider: providerId, modelId: "fake", thinkingLevel: "low" });
      await dispatcher.drain();
      const late = nodeDb.query<{ kind: string }, [string]>("SELECT kind FROM session_outbox WHERE session_id = ?").all(id);
      expect(late.length).toBeGreaterThan(0);
      expect(late.every(row => row.kind === "committed")).toBe(true);

      const other = otherNode(project.id);
      expect(requestSessionMove(id, "other")).toEqual({ state: "moving", nodeId: "other" });
      // It was re-pointed in the same transaction; the old node is fenced at once and was sent nothing:
      // it still holds its copy and its undelivered commit.
      expect(getSession(id)).toMatchObject({ source_id: other.id, placement_status: "moving" });
      await dispatcher.drain();
      expect(moves(id).at(-1)).toEqual({ op: "session.hydrate", state: "queued" });
      expect(nodeDb.query("SELECT 1 FROM sessions WHERE id = ?").get(id)).not.toBeNull();
      const handlers = internalNodeServer(state);
      const notOwner = { code: "not_owner", message: `Node session unavailable: ${id}`, retryable: false };
      for (const write of [
        () => handlers.committed({ sessionId: id, startSeq: 99, writesJson: "[]" }),
        () => handlers.started({ sessionId: id, runId: "stale" }),
        () => handlers.findAttachment(id, attachment.id),
      ]) expect(write).toThrow(expect.objectContaining({ data: notOwner }));

      // The old node reconnects and delivers its late commit: refused with not_owner, so it drops the
      // commit and its copy and does not retry.
      offline = false;
      node.relink();
      await until(() => !nodeDb.query("SELECT 1 FROM sessions WHERE id = ?").get(id), "the old node to drop its copy");
      expect(refusals).toEqual([JSON.stringify(notOwner)]);
      for (const table of ["session_messages", "pi_values", "pi_lists", "pi_usage", "node_attachments", "session_outbox"]) {
        expect(nodeDb.query(`SELECT COUNT(*) n FROM ${table} WHERE session_id = ?`).get(id)).toEqual({ n: 0 });
      }
      node.relink();
      await Bun.sleep(20);
      expect(refusals).toHaveLength(1);
      expect(entries(getDb(), id)).toEqual(before);

      // Node "other" hydrates it; moving it back hydrates the internal node again and the next prompt
      // runs there on the server's history, without the lost model change.
      await acknowledgeOn(id);
      expect(getSession(id)?.placement_status).toBe("provisioned");
      expect(requestSessionMove(id, "internal")).toEqual({ state: "moving", nodeId: "internal" });
      responses.push(fauxAssistantMessage("Back on the node"));
      await executeSessionCommand(state, id, "prompt", text("Still there?"), "second");
      await dispatcher.drain();
      await until(() => settledRuns(id) === 2, "the second run");
      await until(() => !nodeDb.query("SELECT 1 FROM session_outbox").get(), "the node outbox");
      expect(getSession(id)).toMatchObject({ placement_status: "provisioned", source_id: internalSource(project.id).id });
      const after = entries(getDb(), id);
      expect(after.slice(0, before.length)).toEqual(before);
      expect(after.slice(before.length).map(row => row.role)).toEqual(["reinsInput", "assistant"]);
      expect(entries(nodeDb, id)).toEqual(after);
      expect(requests.at(-1)).toEqual(requests[0]!);
      // The prompt attachment was fetched into the node cache again and reached the provider.
      expect(contexts.at(-1)).toContain(PNG.toString("base64"));
    } finally { await node.stop(); }
  }, 20_000);

  test("a failed move of a node-owned session returns it to its previous node with the reason; its next prompt runs there", async () => {
    const node = wrappableNode(state);
    try {
      const { project, id } = await nodeSession("Failed move");
      const internal = getSession(id)!.source_id;
      const before = entries(getDb(), id);
      otherNode(project.id);
      expect(requestSessionMove(id, "other")).toEqual({ state: "moving", nodeId: "other" });
      await rejectOn(id, "Hydration verification failed: digest mismatch");
      // Back where it rested: provisioned on its previous source, with the reason for the UI.
      expect(getSession(id)).toMatchObject({ placement_status: "provisioned", source_id: internal,
        status_error: "Hydration verification failed: digest mismatch" });
      expect(entries(getDb(), id)).toEqual(before);
      responses.push(fauxAssistantMessage("Still on the first node"));
      await executeSessionCommand(state, id, "prompt", text("Still there?"), "after-failed-move");
      await dispatcher.drain();
      await until(() => settledRuns(id) === 2, "the run on the previous node");
      expect(loadMessages(id).at(-1)?.content).toEqual(text("Still on the first node"));
      // A later move clears the old failure.
      expect(requestSessionMove(id, "other")).toEqual({ state: "moving", nodeId: "other" });
      expect(getSession(id)).toMatchObject({ placement_status: "moving", status_error: null });
    } finally { await node.stop(); }
  }, 20_000);

  test("moving back onto a node that kept a stale copy replaces it wholesale (closing its idle runtime); an identical copy is acknowledged", async () => {
    const node = wrappableNode(state);
    try {
      const { project, id } = await nodeSession("Return");
      otherNode(project.id);
      expect(requestSessionMove(id, "other")).toEqual({ state: "moving", nodeId: "other" });
      await acknowledgeOn(id);
      // Node "other" moves the session on (a value it committed), so the internal node's copy is stale.
      const next = getDb().query<{ n: number }, [string]>("SELECT harness_next_seq n FROM sessions WHERE id = ?").get(id)!.n;
      getDb().query("INSERT INTO pi_values (session_id, namespace, key, seq, value_json) VALUES (?, 'test', 'fromOther', ?, '1')").run(id, next);
      getDb().query("UPDATE sessions SET harness_next_seq = ? WHERE id = ?").run(next + 1, id);
      expect(samePiSnapshot(piSnapshotSummary(nodeDb, id), piSnapshotSummary(getDb(), id))).toBe(false);

      expect(requestSessionMove(id, "internal")).toEqual({ state: "moving", nodeId: "internal" });
      const replay = getDb().query<{ id: string }, [string]>("SELECT id FROM node_command_outbox WHERE session_id = ? AND json_extract(command_json, '$.op') = 'session.hydrate' AND state = 'queued'").get(id)!.id;
      const replayed = hydrateCommand(replay);
      responses.push(fauxAssistantMessage("On the replaced copy"));
      await executeSessionCommand(state, id, "prompt", text("Again"), "second");
      await dispatcher.drain();
      await until(() => settledRuns(id) === 2, "the run on the replaced copy");
      await until(() => !nodeDb.query("SELECT 1 FROM session_outbox").get(), "the node outbox");
      expect(moves(id)).toEqual([]);
      expect(getSession(id)?.placement_status).toBe("provisioned");
      expect(nodeDb.query("SELECT key FROM pi_values WHERE session_id = ? AND namespace = 'test'").all(id)).toEqual([{ key: "fromOther" }]);
      // The run continued from the replaced copy: its commits were accepted by the server's replica.
      expect(samePiSnapshot(piSnapshotSummary(nodeDb, id), piSnapshotSummary(getDb(), id))).toBe(true);
      expect(entries(nodeDb, id)).toEqual(entries(getDb(), id));

      // A replay of that hydrate finds the identical copy and is acknowledged without a pull.
      expect(await internalNodeExecutionTarget(state).send(replayed, replay)).toEqual({ ok: true, value: { kind: "hydrated" } });
      expect(samePiSnapshot(piSnapshotSummary(nodeDb, id), piSnapshotSummary(getDb(), id))).toBe(true);
    } finally { await node.stop(); }
  }, 20_000);

  test("moves wait for idle sessions: an active run or pending work blocks a node-owned move", async () => {
    const node = wrappableNode(state);
    try {
      const project = createProject("Busy", dir);
      otherNode(project.id);
      let finish: (() => void) | undefined;
      responses.push(() => new Promise(resolve => { finish = () => resolve(fauxAssistantMessage("Done")); }));
      const { id } = createNewSession(state, project.id, dir, { model: { provider: providerId, modelId: "fake" } });
      await executeSessionCommand(state, id, "prompt", text("Work"), "busy");
      // Queued input ahead of the move.
      expect(() => requestSessionMove(id, "other")).toThrow("Session has an active run or pending input");
      await dispatcher.drain();
      await until(() => getSession(id)?.activity_state === "running" && finish !== undefined, "the run to reach its provider");
      expect(() => requestSessionMove(id, "other")).toThrow("Session has an active run or pending input");
      finish!();
      await until(() => settledRuns(id) === 1, "the run to settle");
      // Other queued work (a model change) blocks it too.
      enqueueSetModel(id, { provider: providerId, modelId: "fake" });
      expect(() => requestSessionMove(id, "other")).toThrow("Session has pending work");
      await dispatcher.drain();
      const internal = getSession(id)!.source_id;
      expect(requestSessionMove(id, "other")).toEqual({ state: "moving", nodeId: "other" });
      // Repeating the move is idempotent; moving elsewhere while it is under way conflicts.
      expect(requestSessionMove(id, "other")).toEqual({ state: "moving", nodeId: "other" });
      expect(() => requestSessionMove(id, "internal")).toThrow("Session is being moved to node other");
      expect(() => requestSessionMove(id, "nowhere")).toThrow("Node nowhere has no source for this session's project");
      expect(getSession(id)!.source_id).not.toBe(internal);

    } finally { await node.stop(); }
  }, 20_000);
});

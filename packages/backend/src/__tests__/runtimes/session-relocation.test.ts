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
import { initializeNodeStorage, setNodeDb } from "@reins/node/storage";
import { piSnapshotSummary, samePiSnapshot } from "@reins/node/pi-storage";
import { getDb } from "../../db.js";
import { setApiKeyCredential } from "../../auth-credentials-store.js";
import { createProject } from "../../project-store.js";
import { internalSource } from "../../node-store.js";
import { createSession, getSession } from "../session-fixture.js";
import { storeSessionAttachment } from "../../session-attachments-store.js";
import { getCommand } from "../../node-command-store.js";
import { dispatcherFor, type NodeCommandDispatcher } from "../../models/node-command-dispatcher.js";
import { deliverCommand, DeliveryDeferred } from "../../models/node-command-transport.js";
import { commitMove, requestSessionMove, SessionMoveConflict } from "../../models/session-ownership.js";
import { getWork } from "../../models/node-command-projection.js";
import { executeSessionCommand } from "../../runtimes/node-execution.js";
import { sendLegacySessionCommand } from "../../runtimes/legacy-session-execution.js";
import { internalNodeExecutionTarget } from "../../runtimes/internal-node-execution.js";
import { createServerTransport } from "../../node-transport/server-peer.js";
import { internalNodeServer, setInternalNodeConnectorForTesting, closeInternalNodeLink, type InternalLink } from "../../runtimes/internal-node.js";
import { NODE_COMMAND_TIMEOUTS } from "../../node-transport/commands.js";
import { registerPiProvider, unregisterPiProvider } from "../../runtimes/pi/factory.js";
import { createNewSession } from "../../runtimes/session-manager.js";
import { loadMessages } from "../../messages-store.js";
import { createServerState } from "../helpers/server-state.js";
import { createRuntimeStub } from "../helpers/test-runtime-stub.js";
import { setupTestDb, teardownTestDb } from "../helpers/test-db.js";
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
  "SELECT json_extract(command_json, '$.op') op, state FROM node_command_outbox WHERE session_id = ? AND json_extract(command_json, '$.op') IN ('session.hydrate', 'session.release') ORDER BY rowid").all(sessionId);

/**
 * A node on an in-memory link whose server handlers the test can wrap (to lose a connection mid-pull
 * or corrupt a page) and that can be restarted over the same node database, as a node process would.
 */
function wrappableNode(state: ServerState, wrap: (handlers: ServerHandlers, link: () => InternalLink) => ServerHandlers = handlers => handlers) {
  let node: Node | undefined;
  let current: InternalLink | undefined;
  const connect = (): InternalLink => {
    node ??= startNode();
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
    /** The node process dies: its connection closes and a new instance starts on the next command. */
    restart() { closeInternalNodeLink(state); node?.stop(); node = undefined; },
    stop() { closeInternalNodeLink(state); node?.stop(); node = undefined; },
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
    nodeDb = new Database(":memory:");
    initializeNodeStorage(nodeDb);
    setNodeDb(nodeDb);
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

  /** A legacy server-owned session with real history, written by the retired server-side runtime: a
   * prompt with an image attachment reference, a tool call whose result carries an inline image, usage
   * and Pi's lane (model and thinking level). */
  async function legacySession(sessionId = "legacy") {
    const project = createProject("Relocation", dir);
    createSession(sessionId, project.id, { agentRuntimeType: "pi", sourceId: internalSource(project.id).id, modelProvider: providerId, modelId: "fake", thinkingLevel: "high" });
    const attachment = storeSessionAttachment(sessionId, { data: new Uint8Array(PNG), mimeType: "image/png", filename: "prompt.png" });
    const image = { type: "image" as const, attachmentId: attachment.id, mimeType: "image/png" as const, byteSize: PNG.byteLength, sha256: attachment.sha256 };
    responses.push(fauxAssistantMessage([fauxToolCall("read", { path: "pixel.png" }, { id: "read-1" })], { stopReason: "toolUse" }), fauxAssistantMessage("Seen on the server"));
    expect(await sendLegacySessionCommand(state, { op: "session.prompt", sessionId, clientId: "legacy-1", content: [...text("Look"), image] }))
      .toMatchObject({ ok: true });
    await state.sessions.get(sessionId)!.runtime.waitForIdle();
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
    expect(state.sessions.has("legacy")).toBe(true);
    const node = wrappableNode(state);
    try {
      responses.push(fauxAssistantMessage("Continued on the node"));
      await executeSessionCommand(state, "legacy", "prompt", text("And now?"), "node-1");
      // The lazy trigger queued the move ahead of the input.
      expect(getDb().query("SELECT json_extract(command_json, '$.op') op FROM node_command_outbox WHERE session_id = 'legacy' ORDER BY rowid").all())
        .toEqual([{ op: "session.hydrate" }, { op: "session.prompt" }]);
      await dispatcher.drain();
      await until(() => settledRuns("legacy") === 1, "the node run to settle");
      await until(() => !nodeDb.query("SELECT 1 FROM session_outbox").get(), "the node outbox to drain");

      // The owner flipped with the hydrate's settlement; the server's live legacy runtime was closed.
      expect(getSession("legacy")?.storage_owner).toBe("internal-node");
      expect(moves("legacy")).toEqual([{ op: "session.hydrate", state: "admitted" }]);
      expect(state.sessions.has("legacy")).toBe(false);
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
    } finally { node.stop(); }
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
      expect(requestSessionMove("legacy", "internal")).toEqual({ state: "hydrating", nodeId: "internal" });
      const id = getDb().query<{ id: string }, []>("SELECT id FROM node_command_outbox WHERE json_extract(command_json, '$.op') = 'session.hydrate'").get()!.id;
      const command = getWork(id)!.command!;
      // First attempt: the link closes mid-pull; the outcome is unknown, so the hydrate is requeued and
      // the node stored nothing.
      await deliverCommand(id, () => internalNodeExecutionTarget(state).send(command, id), result => commitMove("legacy", command, result));
      expect(pages).toBe(1);
      expect(getCommand(id)?.state).toBe("queued");
      expect(nodeDb.query("SELECT 1 FROM sessions WHERE id = 'legacy'").get()).toBeNull();
      expect(getSession("legacy")?.storage_owner).toBe("server");
      node.restart();

      // Second attempt: the node finishes, but its acknowledgement is lost (the call times out).
      const hasty = internalNodeExecutionTarget(state, { ...NODE_COMMAND_TIMEOUTS, hydrate: 1 });
      await expect(hasty.send(command, id)).rejects.toBeInstanceOf(DeliveryDeferred);
      await until(() => !!nodeDb.query("SELECT 1 FROM sessions WHERE id = 'legacy'").get(), "the node to finish hydrating");
      expect(getSession("legacy")?.storage_owner).toBe("server");

      // The node process restarts before the replay, which finds the identical copy by content and is
      // acknowledged at once; the owner flips once.
      node.restart();
      await dispatcher.drain();
      expect(getCommand(id)?.state).toBe("admitted");
      expect(pages).toBe(2);
      expect(getSession("legacy")?.storage_owner).toBe("internal-node");
      expect(samePiSnapshot(piSnapshotSummary(nodeDb, "legacy"), summary)).toBe(true);
    } finally { node.stop(); }
  }, 20_000);

  test("a copy that does not match its digest is rejected: the session stays at rest on the server and its input fails", async () => {
    const { project } = await legacySession();
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
      expect(getSession("legacy")?.storage_owner).toBe("server");
      expect(nodeDb.query("SELECT 1 FROM sessions WHERE id = 'legacy'").get()).toBeNull();
      expect(moves("legacy")).toEqual([]);
      expect(events).toContainEqual({ type: "error", sessionId: "legacy", error: expect.stringContaining("Session move failed: Hydration verification failed") });
      // The input behind it tried to move the session itself, failed the same way and was removed.
      expect(getDb().query("SELECT 1 FROM node_command_outbox WHERE json_extract(command_json, '$.clientId') = 'after-forgery'").get()).toBeNull();
      expect(project.id).toBeGreaterThan(0);
    } finally { node.stop(); }
  }, 20_000);

  test("release: a node-owned session is handed back complete, its node copy dropped, and its next use hydrates it again", async () => {
    let slowSnapshot = false;
    // A slow server snapshot makes a release outlast its call, so its acknowledgement is lost.
    const node = wrappableNode(state, handlers => ({ ...handlers, snapshot: async (sessionId, fromSeq) => {
      if (slowSnapshot) { slowSnapshot = false; await Bun.sleep(30); }
      return handlers.snapshot(sessionId, fromSeq);
    } }));
    try {
      const project = createProject("Release", dir);
      responses.push(fauxAssistantMessage("First on the node"));
      const { id } = createNewSession(state, project.id, dir, { model: { provider: providerId, modelId: "fake" } });
      const attachment = storeSessionAttachment(id, { data: new Uint8Array(PNG), mimeType: "image/png" });
      await executeSessionCommand(state, id, "prompt", [...text("Hello"), { type: "image", attachmentId: attachment.id, mimeType: "image/png", byteSize: PNG.byteLength, sha256: attachment.sha256 }], "first");
      await dispatcher.drain();
      await until(() => settledRuns(id) === 1, "the first run");
      await until(() => !nodeDb.query("SELECT 1 FROM session_outbox").get(), "the node outbox");
      const nodeCopy = piSnapshotSummary(nodeDb, id);
      const before = entries(getDb(), id);

      expect(requestSessionMove(id, null)).toEqual({ state: "releasing", nodeId: "internal" });
      // The node releases, but its acknowledgement is lost (the call times out) and the node process
      // restarts before the replay: the node keeps nothing for the session, answers `not_found`, and the
      // server takes that as released with its own (matching) copy.
      const releaseId = getDb().query<{ id: string }, [string]>("SELECT id FROM node_command_outbox WHERE session_id = ? AND json_extract(command_json, '$.op') = 'session.release'").get(id)!.id;
      slowSnapshot = true;
      const hasty = internalNodeExecutionTarget(state, { ...NODE_COMMAND_TIMEOUTS, release: 5 });
      await expect(hasty.send(getWork(releaseId)!.command!, releaseId)).rejects.toBeInstanceOf(DeliveryDeferred);
      await until(() => !nodeDb.query("SELECT 1 FROM sessions WHERE id = ?").get(id), "the node to drop its copy");
      expect(getSession(id)?.storage_owner).toBe("internal-node");
      node.restart();
      await dispatcher.drain();
      expect(moves(id)).toEqual([{ op: "session.release", state: "admitted" }]);
      expect(getSession(id)?.storage_owner).toBe("server");
      // The server's copy is complete; the node holds nothing for the session.
      expect(samePiSnapshot(piSnapshotSummary(getDb(), id), nodeCopy)).toBe(true);
      for (const table of ["sessions", "session_messages", "pi_values", "pi_lists", "pi_usage", "node_attachments", "session_outbox"]) {
        expect(nodeDb.query(`SELECT COUNT(*) n FROM ${table} WHERE ${table === "sessions" ? "id" : "session_id"} = ?`).get(id)).toEqual({ n: 0 });
      }

      // Fencing: the node no longer owns the session, so a stale report from it is rejected.
      const handlers = internalNodeServer(state);
      expect(() => handlers.committed({ sessionId: id, startSeq: nodeCopy.harnessNextSeq, writesJson: "[]" })).toThrow(`Node session unavailable: ${id}`);
      expect(() => handlers.started({ sessionId: id, runId: "stale" })).toThrow(`Node session unavailable: ${id}`);
      expect(() => handlers.findAttachment(id, attachment.id)).toThrow(`Node session unavailable: ${id}`);

      // Its next use moves it back through the server: server → node again (standing in for node B).
      node.restart();
      responses.push(fauxAssistantMessage("Back on the node"));
      await executeSessionCommand(state, id, "prompt", text("Still there?"), "second");
      await dispatcher.drain();
      await until(() => settledRuns(id) === 2, "the second run");
      await until(() => !nodeDb.query("SELECT 1 FROM session_outbox").get(), "the node outbox");
      expect(getSession(id)?.storage_owner).toBe("internal-node");
      const after = entries(getDb(), id);
      expect(after.slice(0, before.length)).toEqual(before);
      expect(after.slice(before.length).map(row => row.role)).toEqual(["reinsInput", "assistant"]);
      expect(entries(nodeDb, id)).toEqual(after);
      // The prompt attachment was fetched into the new node cache and reached the provider again.
      expect(contexts.at(-1)).toContain(PNG.toString("base64"));
    } finally { node.stop(); }
  }, 20_000);

  test("moves wait for idle sessions: an active run or pending work blocks a release; a running legacy runtime blocks a hydrate", async () => {
    const node = wrappableNode(state);
    try {
      const project = createProject("Busy", dir);
      let release: (() => void) | undefined;
      responses.push(() => new Promise(resolve => { release = () => resolve(fauxAssistantMessage("Done")); }));
      const { id } = createNewSession(state, project.id, dir, { model: { provider: providerId, modelId: "fake" } });
      await executeSessionCommand(state, id, "prompt", text("Work"), "busy");
      // Queued input ahead of the move.
      expect(() => requestSessionMove(id, null)).toThrow(SessionMoveConflict);
      await dispatcher.drain();
      await until(() => getSession(id)?.activity_state === "running" && release !== undefined, "the run to reach its provider");
      expect(() => requestSessionMove(id, null)).toThrow("Session has an active run or pending input");
      // The node itself refuses to drop a session with an active run.
      const releaseId = crypto.randomUUID();
      expect(await internalNodeExecutionTarget(state).send({ op: "session.release", sessionId: id }, releaseId))
        .toEqual({ ok: false, error: { code: "busy", message: `Session ${id} has an active run; release refused`, retryable: false } });
      expect(nodeDb.query("SELECT 1 FROM sessions WHERE id = ?").get(id)).not.toBeNull();
      release!();
      await until(() => settledRuns(id) === 1, "the run to settle");
      expect(requestSessionMove(id, null)).toEqual({ state: "releasing", nodeId: "internal" });
      // Moving it elsewhere while it is being released conflicts; repeating the release is idempotent.
      expect(() => requestSessionMove(id, "internal")).toThrow("Session is being released to the server");
      expect(requestSessionMove(id, null)).toEqual({ state: "releasing", nodeId: "internal" });
      await dispatcher.drain();
      expect(getSession(id)?.storage_owner).toBe("server");

      // A legacy runtime still streaming on the server blocks the hydrate, which fails with a clear error.
      state.sessions.set(id, { id, lastActivity: 0, runtime: createRuntimeStub({ isStreaming: true }).runtime });
      expect(requestSessionMove(id, "internal")).toEqual({ state: "hydrating", nodeId: "internal" });
      await dispatcher.drain();
      expect(getSession(id)?.storage_owner).toBe("server");
      expect(moves(id).at(-1)).toEqual({ op: "session.release", state: "admitted" });
      state.sessions.delete(id);
      expect(() => requestSessionMove(id, "nowhere")).toThrow("Node nowhere has no source for this session's project");
    } finally { node.stop(); }
  }, 20_000);
});

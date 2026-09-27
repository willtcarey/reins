import { test, expect, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { NodeCommand } from "@reins/node/contract";
import { nodeRuntimesForTesting, startNode } from "@reins/node/node";
import { connectLocalNode } from "@reins/node/local-link";
import { setNodeDb } from "@reins/node/storage";
import { createNodeConnection, createRpcPeer, LOCAL_LINK, LOCAL_MAX_FRAME_BYTES, ndjsonSocketHandler, provisionResult, readyResult, sessionCommittedResult, type LinkOptions, type NdjsonSocket } from "@reins/node/protocol";
import { setDb } from "../../db.js";
import { runMigrations } from "../../migrations.js";
import { createProject } from "../../project-store.js";
import { internalSource } from "../../node-store.js";
import { createSession } from "../../session-store.js";
import { storeSessionAttachment } from "../../session-attachments-store.js";
import { DeliveryDeferred } from "../../models/node-command-transport.js";
import { executionTargetFor } from "../../runtimes/execution-target.js";
import { acceptInternalNodeConnection, sendInternal, stopInternalNode } from "../../runtimes/internal-node.js";
import { listenLocalNodeSocket } from "../../node-transport/local-socket.js";
import { registerPiProvider, unregisterPiProvider } from "../../runtimes/pi/factory.js";
import { setApiKeyCredential } from "../../auth-credentials-store.js";
import { createServerState } from "../helpers/server-state.js";

const until = async (condition: () => boolean, tries = 1000) => { for (let i = 0; i < tries && !condition(); i++) await Bun.sleep(5); expect(condition()).toBe(true); };
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

/** Product and node databases plus a server in socket mode listening on a temp Unix socket; every frame
 * the server receives is recorded by method. */
async function socketServer(name: string, accept: LinkOptions = LOCAL_LINK) {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON"); setDb(db); runMigrations(db);
  const nodeDb = new Database(":memory:");
  setNodeDb(nodeDb);
  const dir = mkdtempSync(join(tmpdir(), "reins-node-socket-"));
  const state = createServerState({ internalNodeLink: "socket" });
  const received: string[] = [];
  const accepted: NdjsonSocket[] = [];
  const listener = await listenLocalNodeSocket(join(dir, "run", "node.sock"), socket => {
    accepted.push(socket);
    acceptInternalNodeConnection(state, socket, accept);
    const serve = socket.onmessage!;
    socket.onmessage = data => { received.push(JSON.parse(data).method ?? "reply"); serve(data); };
  });
  const project = createProject(name, dir);
  const source = internalSource(project.id);
  const dispose = () => { listener.stop(); stopInternalNode(state); setNodeDb(); nodeDb.close(); setDb(new Database(":memory:")); db.close(); rmSync(dir, { recursive: true, force: true }); };
  return { db, nodeDb, dir, state, listener, received, accepted, project, source, dispose };
}

/** A raw node end on the server's socket, wired before any frame can arrive. */
async function dial(path: string, wire: (socket: NdjsonSocket) => void) {
  let socket: NdjsonSocket | undefined;
  await Bun.connect({ unix: path, socket: ndjsonSocketHandler(LOCAL_MAX_FRAME_BYTES, opened => { socket = opened; wire(opened); }) });
  return socket!;
}

test("a node process client on the local Unix socket negotiates, provisions and runs prompts with commits, events, lifecycle reports, attachments and credentials crossing the socket, and continues after the server drops the connection", async () => {
  const server = await socketServer("socket-e2e");
  const { db, nodeDb, dir, state, listener, received, accepted, source } = server;
  writeFileSync(join(dir, "pixel.png"), PNG);
  let dropped = false;
  const provider = fauxProvider({ provider: "socket-e2e-faux", models: [{ id: "fake", input: ["text", "image"], contextWindow: 200_000, maxTokens: 1_000 }] });
  const steps: FauxResponseStep[] = [
    fauxAssistantMessage([fauxToolCall("read", { path: "pixel.png" }, { id: "read" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Seen"),
    // Mid-run, the server drops the node's connection: the rest of this run is committed and settled
    // while the node is disconnected and replays from its outbox once it has redialed.
    () => { dropped = true; stopInternalNode(state); return fauxAssistantMessage("Second"); },
    fauxAssistantMessage("Third"),
  ];
  provider.setResponses(steps);
  registerPiProvider(provider.provider);
  setApiKeyCredential(provider.provider.id, "test-key");
  const browser: Array<{ type: string; sessionId?: string; event?: { type: string } }> = [];
  state.clients.add({ ws: { send: data => { browser.push(JSON.parse(data)); return 0; } } });
  createSession("s", server.project.id, { agentRuntimeType: "pi", sourceId: source.id, storageOwner: "internal-node" });
  const node = startNode();
  // Reconnect after 300–600ms so the dropped run finishes while the node is offline.
  const client = connectLocalNode(node, { path: listener.path, backoff: { initialMs: 600, maxMs: 600 } });
  const target = executionTargetFor(state, { id: "s", storage_owner: "internal-node" });
  const settled = () => db.query<{ n: number }, []>("SELECT COUNT(*) n FROM node_lifecycle_receipts WHERE session_id = 's' AND kind = 'settled'").get()!.n;
  const replica = () => JSON.stringify(db.query("SELECT message_json FROM session_messages WHERE session_id = 's'").all());
  /** Submitted work is requeued while no connection is negotiated; a replay converges on the node's receipt. */
  const deliver = async (command: NodeCommand, commandId: string) => {
    for (let i = 0; ; i++) {
      try { return await target.send(command, commandId); }
      catch (error) { if (!(error instanceof DeliveryDeferred) || i > 400) throw error; await Bun.sleep(5); }
    }
  };
  const prompt = (clientId: string, content: Extract<NodeCommand, { op: "session.prompt" }>["content"]) =>
    deliver({ op: "session.prompt", sessionId: "s", clientId, content }, clientId);
  try {
    expect(await deliver({ op: "session.provision", sessionId: "s", sourceId: source.id,
      configuration: { model: { provider: provider.provider.id, modelId: "fake" }, thinkingLevel: null, task: null } }, "provision")).toEqual({ ok: true, value: { kind: "provisioned" } });
    // Different bytes from the file the tool reads, so the tool result is a new node-created attachment.
    const prompted = Buffer.concat([PNG, Buffer.from([0])]);
    const upload = storeSessionAttachment("s", { data: new Uint8Array(prompted), mimeType: "image/png" });
    const image = { type: "image" as const, attachmentId: upload.id, mimeType: "image/png" as const, byteSize: prompted.byteLength, sha256: upload.sha256 };
    expect(await prompt("first", [{ type: "text", text: "Read it" }, image])).toEqual({ ok: true, value: { kind: "admitted", inputId: "first" } });
    await until(() => settled() === 1);
    await until(() => !nodeDb.query("SELECT 1 FROM session_outbox").get());
    for (const method of ["node.hello", "credentials.get", "attachment.fetch", "attachment.store", "session.committed", "session.started", "session.settled", "session.event"]) expect(received).toContain(method);
    // The node-created tool-result image was uploaded under its node ID, and the transcript holds references.
    const stored = db.query<{ id: string }, [string]>("SELECT id FROM session_attachments WHERE session_id = 's' AND id != ?").all(upload.id);
    expect(stored).toHaveLength(1);
    expect(replica()).toContain("Seen");
    expect(replica()).toContain(stored[0]!.id);
    expect(browser.some(message => message.type === "event" && message.sessionId === "s" && message.event?.type === "agent_end")).toBe(true);

    expect(await prompt("second", [{ type: "text", text: "Again" }])).toEqual({ ok: true, value: { kind: "admitted", inputId: "second" } });
    await until(() => dropped);
    // Offline: the run's commits and settlement wait in the node outbox.
    await until(() => !!nodeDb.query("SELECT 1 FROM session_outbox WHERE kind = 'settled'").get());
    expect(settled()).toBe(1);
    // Redialed: a new connection negotiates and the outbox replays.
    await until(() => settled() === 2);
    await until(() => !nodeDb.query("SELECT 1 FROM session_outbox").get());
    expect(accepted).toHaveLength(2);
    expect(accepted[0]!.closed).toBe(true);
    expect(received.filter(method => method === "node.hello")).toHaveLength(2);
    expect(replica()).toContain("Second");

    expect(await prompt("third", [{ type: "text", text: "More" }])).toEqual({ ok: true, value: { kind: "admitted", inputId: "third" } });
    await until(() => settled() === 3);
    await until(() => replica().includes("Third"));
    await nodeRuntimesForTesting(node).close("s");
  } finally {
    client.stop(); node.stop(); unregisterPiProvider(provider.provider.id); server.dispose();
  }
}, 30_000);

test("a newly negotiated connection supersedes the old one: the old connection's in-flight command is deferred, its epoch is fenced, and commands go to the new one", async () => {
  const server = await socketServer("socket-supersede");
  const binding = { sourceId: server.source.id, cwd: server.dir, createdAt: "2026-01-01T00:00:00Z", parentSessionId: null };
  const provision: NodeCommand = { op: "session.provision", sessionId: "s", sourceId: server.source.id, configuration: { model: null, thinkingLevel: null, task: null } };
  try {
    // Nothing connected: submitted work is deferred.
    await expect(sendInternal(server.state, provision, binding, "c0")).rejects.toBeInstanceOf(DeliveryDeferred);
    const provisions: string[] = [];
    const old = createNodeConnectionOn(await dial(server.listener.path, () => {}), async () => { provisions.push("old"); return new Promise<never>(() => {}); });
    const oldEpoch = (await old.connection.ready).epoch;
    const inFlight = sendInternal(server.state, provision, binding, "c1").then(() => undefined, (error: unknown) => error);
    await until(() => provisions.length === 1);

    const seen: string[] = [];
    const wire = await dial(server.listener.path, () => {});
    const peer = createRpcPeer(wire, {
      "session.provision": { params: epochParams, result: provisionResult, handle: async params => { seen.push(epochParams.parse(params).epoch); return { provisioned: true }; } },
    });
    wire.onmessage = peer.receive; wire.onclose = peer.close;
    const { epoch } = await peer.call("node.hello", { instanceId: "new", minVersion: 1, maxVersion: 1, capabilities: ["session.provision"] }, readyResult);

    // The old connection is closed: its in-flight command's outcome is unknown, so it is requeued.
    expect(await inFlight).toBeInstanceOf(DeliveryDeferred);
    await until(() => old.socket.closed);
    // Only the epoch this connection was issued is accepted on it.
    await expect(peer.call("session.committed", { epoch: oldEpoch, sessionId: "s", startSeq: 1, writesJson: "[]" }, sessionCommittedResult)).rejects.toMatchObject({ code: -32003 });
    await expect(peer.call("session.committed", { epoch, sessionId: "s", startSeq: 1, writesJson: "[]" }, sessionCommittedResult)).rejects.toMatchObject({ code: -32000, message: "Session not found: s" });
    expect(await sendInternal(server.state, provision, binding, "c1")).toEqual({ ok: true, value: { kind: "provisioned" } });
    expect(seen).toEqual([epoch]);
    peer.close();
  } finally { server.dispose(); }
});

const epochParams = z.looseObject({ epoch: z.string() });

/** A node end using the real node-side connection with a scripted provision handler. */
function createNodeConnectionOn(socket: NdjsonSocket, provision: () => Promise<{ provisioned: true }>) {
  const connection = createNodeConnection(socket, {
    instanceId: "old", minVersion: 1, maxVersion: 1, capabilities: ["session.provision"],
    provision, status: async () => ({ provisioned: false }),
  });
  socket.onmessage = connection.receive; socket.onclose = connection.close;
  return { socket, connection };
}

test("the server closes a connection that never negotiates and, by heartbeat, one whose node stops responding; neither becomes the link", async () => {
  const intervals: Array<() => void> = [];
  const timeouts: Array<() => void> = [];
  const timers = {
    setTimeout: (callback: () => void) => timeouts.push(callback),
    clearTimeout: () => {},
    setInterval: (callback: () => void) => intervals.push(callback),
    clearInterval: () => {},
  };
  const server = await socketServer("socket-liveness", { ...LOCAL_LINK, timers });
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const binding = { sourceId: server.source.id, cwd: server.dir, createdAt: "2026-01-01T00:00:00Z", parentSessionId: null };
  const provision: NodeCommand = { op: "session.provision", sessionId: "s", sourceId: server.source.id, configuration: { model: null, thinkingLevel: null, task: null } };
  try {
    const silent = await dial(server.listener.path, () => {});
    await until(() => timeouts.length === 1);
    for (const fire of timeouts.splice(0)) fire();
    await until(() => silent.closed);
    await expect(sendInternal(server.state, provision, binding, "c1")).rejects.toBeInstanceOf(DeliveryDeferred);

    // Negotiates, then hangs: it never reads or writes again.
    const hung = await dial(server.listener.path, () => {});
    const peer = createRpcPeer(hung, {});
    hung.onmessage = peer.receive;
    await peer.call("node.hello", { instanceId: "hung", minVersion: 1, maxVersion: 1, capabilities: [] }, readyResult);
    hung.onmessage = () => {};
    const tick = () => { for (const beat of intervals) beat(); };
    await until(() => intervals.length === 2);
    tick(); tick(); tick();
    expect(hung.closed).toBe(false);
    tick();
    await until(() => hung.closed);
    expect(warn.mock.calls.some(([message]) => String(message).includes("heartbeat"))).toBe(true);
    await expect(sendInternal(server.state, provision, binding, "c1")).rejects.toBeInstanceOf(DeliveryDeferred);
  } finally { warn.mockRestore(); server.dispose(); }
});

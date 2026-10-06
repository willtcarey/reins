import { scriptedCommandHandlers } from "@reins/node-protocol/testing";
import { test, expect, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { acknowledgedResult, createNodeConnection, createRpcPeer, protocolVersion, LOCAL_LINK, LOCAL_MAX_FRAME_BYTES, ndjsonSocketHandler, readyResult, sessionInputResult, type NodeCommand, type LinkOptions, type NdjsonSocket, DeliveryDeferred, APPLICATION_ERROR, UNAUTHORIZED } from "@reins/node-protocol";
import { nodeRuntimesForTesting, startNode } from "@reins/node/node";
import { connectLocalNode } from "@reins/node/local-link";
import { setDb, getDb } from "../../db.js";
import { runMigrations } from "../../migrations.js";
import { createProject } from "../project-fixture.js";
import { defaultSource, createSource } from "../../node-store.js";
import { createSession } from "../../session-store.js";
import { storeSessionAttachment } from "../../session-attachments-store.js";
import { listenLocalNodeSocket } from "../../node-link/local-socket.js";
import { registerPiProvider, unregisterPiProvider } from "../helpers/pi-providers.js";
import { setApiKeyCredential } from "../../auth-credentials-store.js";
import { createServerState } from "../helpers/server-state.js";
import { Sessions } from "../../models/sessions.js";
import { enqueueInput, getNodeCommand } from "../../node-link/node-command-store.js";
import { useFakeNode, type ReceivedCommand } from "../helpers/fake-node.js";
import { drainCommands } from "../helpers/loopback-node.js";
import { deliverNow } from "../helpers/node-session.js";

const until = async (condition: () => boolean, tries = 1000) => { for (let i = 0; i < tries && !condition(); i++) await Bun.sleep(5); expect(condition()).toBe(true); };
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

/** A product database plus a server in socket mode listening on a temp Unix socket; every frame
 * the server receives is recorded by method. */
async function socketServer(name: string, accept: LinkOptions = LOCAL_LINK) {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON"); setDb(db); runMigrations(db);
  const dir = mkdtempSync(join(tmpdir(), "reins-node-socket-"));
  const state = createServerState();
  const received: string[] = [];
  const accepted: NdjsonSocket[] = [];
  const listener = await listenLocalNodeSocket(join(dir, "run", "node.sock"), socket => {
    accepted.push(socket);
    state.nodes.accept(socket, accept);
    const serve = socket.onmessage!;
    socket.onmessage = data => { received.push(JSON.parse(data).method ?? "reply"); serve(data); };
  });
  const project = createProject(name, dir);
  const source = defaultSource(project.id)!;
  const dispose = () => { listener.stop(); state.nodes.close(); setDb(new Database(":memory:")); db.close(); rmSync(dir, { recursive: true, force: true }); };
  return { db, dir, state, listener, received, accepted, project, source, dispose };
}

/** A raw node end on the server's socket, wired before any frame can arrive. */
async function dial(path: string, wire: (socket: NdjsonSocket) => void) {
  let socket: NdjsonSocket | undefined;
  await Bun.connect({ unix: path, socket: ndjsonSocketHandler(LOCAL_MAX_FRAME_BYTES, opened => { socket = opened; wire(opened); }) });
  return socket!;
}

const text = [{ type: "text" as const, text: "hi" }];
const ops = (commands: ReceivedCommand[]) => commands.map(command => [command.op, command.sessionId]);
function withDb(run: (projectId: number, sourceId: number) => Promise<void> | void) {
  return async () => {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON"); setDb(db); runMigrations(db);
    try {
      const project = createProject("targets", "/tmp/targets");
      await run(project.id, defaultSource(project.id)!.id);
    } finally { setDb(new Database(":memory:")); db.close(); }
  };
}

test("a node process client on the local Unix socket negotiates and runs prompts with storage, events, lifecycle reports, attachments and credentials crossing the socket; a run whose connection drops finishes over the node's next one", async () => {
  const server = await socketServer("socket-e2e");
  const { db, dir, state, listener, received, accepted, source } = server;
  writeFileSync(join(dir, "pixel.png"), PNG);
  const reached = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const provider = fauxProvider({ provider: "socket-e2e-faux", models: [{ id: "fake", input: ["text", "image"], contextWindow: 200_000, maxTokens: 1_000 }] });
  const steps: FauxResponseStep[] = [
    fauxAssistantMessage([fauxToolCall("read", { path: "pixel.png" }, { id: "read" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Seen"),
    // Held mid-run while the server drops the node's connection (see below).
    async () => { reached.resolve(); await gate.promise; return fauxAssistantMessage("Second"); },
    fauxAssistantMessage("Third"),
  ];
  provider.setResponses(steps);
  registerPiProvider(provider.provider);
  setApiKeyCredential(provider.provider.id, "test-key");
  const browser: Array<{ type: string; sessionId?: string; event?: { type: string } }> = [];
  state.clients.add({ ws: { send: data => { browser.push(JSON.parse(data)); return 0; } } });
  createSession("s", server.project.id, { agentRuntimeType: "pi", sourceId: source.id, modelProvider: provider.provider.id, modelId: "fake" });
  const node = startNode();
  const statuses: string[] = [];
  const client = connectLocalNode(node, { path: listener.path, backoff: { initialMs: 600, maxMs: 600 }, onStatus: status => statuses.push(status) });
  const settled = () => db.query<{ n: number }, []>("SELECT settlement_count n FROM sessions WHERE id = 's'").get()!.n;
  const transcript = () => JSON.stringify(db.query("SELECT message_json FROM session_messages WHERE session_id = 's'").all());
  /** Submitted work is requeued while no connection is negotiated; a replay converges on the server's copy. */
  const deliver = async (command: NodeCommand) => {
    for (let i = 0; ; i++) {
      try { return await deliverNow(state, command); }
      catch (error) { if (!(error instanceof DeliveryDeferred) || i > 400) throw error; await Bun.sleep(5); }
    }
  };
  const prompt = (clientId: string, content: Extract<NodeCommand, { op: "session.prompt" }>["content"]) =>
    deliver({ op: "session.prompt", sessionId: "s", clientId, content, sourceSessionId: null });
  try {
    // Different bytes from the file the tool reads, so the tool result is a new node-created attachment.
    const prompted = Buffer.concat([PNG, Buffer.from([0])]);
    const upload = storeSessionAttachment("s", { data: new Uint8Array(prompted), mimeType: "image/png" });
    const image = { type: "image" as const, attachmentId: upload.id, mimeType: "image/png" as const, byteSize: prompted.byteLength, sha256: upload.sha256 };
    expect(await prompt("first", [{ type: "text", text: "Read it" }, image])).toEqual({ ok: true, value: { inputId: "first" } });
    await until(() => settled() === 1);
    for (const method of ["node.hello", "credentials.get", "attachment.fetch", "attachment.store", "storage.read", "storage.commit", "session.started", "session.settled", "session.event"]) expect(received).toContain(method);
    // The node-created tool-result image was uploaded under its node ID, and the transcript holds references.
    const stored = db.query<{ id: string }, [string]>("SELECT id FROM session_attachments WHERE session_id = 's' AND id != ?").all(upload.id);
    expect(stored).toHaveLength(1);
    expect(transcript()).toContain("Seen");
    expect(transcript()).toContain(stored[0]!.id);
    expect(browser.some(message => message.type === "event" && message.sessionId === "s" && message.event?.type === "agent_end")).toBe(true);

    expect(await prompt("second", [{ type: "text", text: "Again" }])).toEqual({ ok: true, value: { inputId: "second" } });
    // Mid-run, the server drops the node's connection; once the node has seen it close, the run's next
    // commit waits for the node to redial (after 600ms) and goes over the new connection. The
    // new connection's hello lists the session as live, so the server leaves the run alone.
    await reached.promise;
    accepted.at(-1)!.close();
    await until(() => statuses.includes("disconnected"));
    gate.resolve();
    await until(() => settled() === 2);
    expect(accepted).toHaveLength(2);
    expect(accepted[0]!.closed).toBe(true);
    expect(received.filter(method => method === "node.hello")).toHaveLength(2);
    expect(JSON.parse(db.query<{ settlement_json: string }, []>("SELECT settlement_json FROM sessions WHERE id = 's'").get()!.settlement_json))
      .toMatchObject({ status: "completed" });
    expect(transcript()).toContain("Second");

    expect(await prompt("third", [{ type: "text", text: "More" }])).toEqual({ ok: true, value: { inputId: "third" } });
    await until(() => settled() === 3);
    expect(transcript()).toContain("Third");
    await until(() => !node.liveSessions().includes("s"));
    await nodeRuntimesForTesting(node).close("s");
  } finally {
    client.stop(); await node.shutdown(); unregisterPiProvider(provider.provider.id); server.dispose();
  }
}, 30_000);

test("a newly negotiated connection supersedes the old one: the old connection's in-flight command is deferred, its epoch is fenced, and commands go to the new one", async () => {
  const server = await socketServer("socket-supersede");
  createSession("s", server.project.id, { agentRuntimeType: "pi", sourceId: server.source.id });
  const prompt: NodeCommand = { op: "session.prompt", sessionId: "s", clientId: "c", content: [{ type: "text", text: "Hi" }], sourceSessionId: null };
  try {
    // Nothing connected: submitted work is deferred.
    await expect(deliverNow(server.state, prompt)).rejects.toBeInstanceOf(DeliveryDeferred);
    const prompts: string[] = [];
    const old = createNodeConnectionOn(await dial(server.listener.path, () => {}), async () => { prompts.push("old"); return new Promise<never>(() => {}); });
    const oldEpoch = (await old.connection.ready).epoch;
    const inFlight = deliverNow(server.state, prompt).then(() => undefined, (error: unknown) => error);
    await until(() => prompts.length === 1);

    const seen: string[] = [];
    const wire = await dial(server.listener.path, () => {});
    const peer = createRpcPeer(wire, {
      "session.prompt": { params: epochParams, result: sessionInputResult, handle: async params => { seen.push(epochParams.parse(params).epoch); return { inputId: "c" }; } },
    });
    wire.onmessage = peer.receive; wire.onclose = peer.close;
    const { epoch } = await peer.call("node.hello", { nodeId: "internal", minVersion: protocolVersion, maxVersion: protocolVersion, capabilities: ["session.prompt"], liveSessions: [] }, readyResult);

    // The old connection is closed: its in-flight command's outcome is unknown, so it is requeued.
    expect(await inFlight).toBeInstanceOf(DeliveryDeferred);
    await until(() => old.socket.closed);
    // Only the epoch this connection was issued is accepted on it.
    await expect(peer.call("session.started", { epoch: oldEpoch, sessionId: "s", runId: "r" }, acknowledgedResult)).rejects.toMatchObject({ code: UNAUTHORIZED });
    await expect(peer.call("session.started", { epoch, sessionId: "unknown", runId: "r" }, acknowledgedResult)).rejects.toMatchObject({ code: APPLICATION_ERROR, message: "Session not found: unknown" });
    expect(await deliverNow(server.state, prompt)).toEqual({ ok: true, value: { inputId: "c" } });
    expect(seen).toEqual([epoch]);
    peer.close();
  } finally { server.dispose(); }
});

const epochParams = z.looseObject({ epoch: z.string() });

/** A node end using the real node-side connection with a scripted prompt handler. */
function createNodeConnectionOn(socket: NdjsonSocket, prompt: () => Promise<{ inputId: string }>) {
  const connection = createNodeConnection(socket, {
    nodeId: "internal", minVersion: protocolVersion, maxVersion: protocolVersion, capabilities: ["session.prompt"], liveSessions: [],
    ...scriptedCommandHandlers({ prompt }),
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
  createSession("s", server.project.id, { agentRuntimeType: "pi", sourceId: server.source.id });
  const prompt: NodeCommand = { op: "session.prompt", sessionId: "s", clientId: "c", content: [{ type: "text", text: "Hi" }], sourceSessionId: null };
  try {
    const silent = await dial(server.listener.path, () => {});
    await until(() => timeouts.length === 1);
    for (const fire of timeouts.splice(0)) fire();
    await until(() => silent.closed);
    await expect(deliverNow(server.state, prompt)).rejects.toBeInstanceOf(DeliveryDeferred);

    // Negotiates, then hangs: it never reads or writes again.
    const hung = await dial(server.listener.path, () => {});
    const peer = createRpcPeer(hung, {});
    hung.onmessage = peer.receive;
    await peer.call("node.hello", { nodeId: "internal", minVersion: protocolVersion, maxVersion: protocolVersion, capabilities: [], liveSessions: [] }, readyResult);
    hung.onmessage = () => {};
    const tick = () => { for (const beat of intervals) beat(); };
    await until(() => intervals.length === 2);
    tick(); tick(); tick();
    expect(hung.closed).toBe(false);
    tick();
    await until(() => hung.closed);
    expect(warn.mock.calls.some(([message]) => String(message).includes("heartbeat"))).toBe(true);
    await expect(deliverNow(server.state, prompt)).rejects.toBeInstanceOf(DeliveryDeferred);
  } finally { warn.mockRestore(); server.dispose(); }
});

test("a connection is served only for the node ID it announces if that node exists; a new connection supersedes only its own node's link", async () => {
  const server = await socketServer("socket-identity");
  server.db.exec("INSERT INTO nodes VALUES ('remote', 'Remote')");
  /** A raw node end announcing `nodeId`; resolves with its hello's outcome. */
  const hello = async (nodeId: string) => {
    const wire = await dial(server.listener.path, () => {});
    const peer = createRpcPeer(wire, {});
    wire.onmessage = peer.receive; wire.onclose = peer.close;
    const ready = peer.call("node.hello", { nodeId, minVersion: protocolVersion, maxVersion: protocolVersion, capabilities: [], liveSessions: [] }, readyResult);
    return { wire, ready };
  };
  try {
    // Unknown node: refused at hello, never a link (enrollment of new nodes is future work).
    const stranger = await hello("stranger");
    await expect(stranger.ready).rejects.toMatchObject({ code: UNAUTHORIZED, message: "Unknown node: stranger" });
    expect(server.state.nodes.get("stranger").connected).toBe(false);

    const local = await hello("internal");
    const remote = await hello("remote");
    await Promise.all([local.ready, remote.ready]);
    await until(() => server.state.nodes.get("internal").connected && server.state.nodes.get("remote").connected);
    // A new connection for one node closes that node's previous link only.
    const redialed = await hello("internal");
    await redialed.ready;
    await until(() => local.wire.closed);
    expect(remote.wire.closed).toBe(false);
    expect([server.state.nodes.get("internal").connected, server.state.nodes.get("remote").connected]).toEqual([true, true]);
    remote.wire.close();
    await until(() => !server.state.nodes.get("remote").connected);
    expect(server.state.nodes.get("internal").connected).toBe(true);
    redialed.wire.close();
  } finally { server.dispose(); }
});
test("the hub delivers prompt and steer to the session's node in outbox order", withDb(async (projectId, sourceId) => {
  createSession("node", projectId, { agentRuntimeType: "pi", sourceId });
  const state = createServerState();
  const node = useFakeNode(state);
  const ids = [enqueueInput("node", "prompt", text, "node-p")!, enqueueInput("node", "steer", text, "node-s")!];
  await drainCommands(state);
  // Delivered commands leave the outbox.
  for (const id of ids) expect(getNodeCommand(id)).toBeNull();
  expect(node.sent).toEqual([
    { op: "session.prompt", sessionId: "node", clientId: "node-p", content: text, sourceSessionId: null },
    { op: "session.steer", sessionId: "node", clientId: "node-s", content: text, sourceSessionId: null },
  ]);
}));

test("no node is special: work for sessions on a second node's source goes to that node when it connects, the seeded node's to it", withDb(async (projectId, sourceId) => {
  getDb().exec("INSERT INTO nodes VALUES ('remote', 'Remote')");
  const remote = createSource(projectId, "remote", "/remote/targets");
  const state = createServerState();
  for (const [sessionId, source] of [["local", sourceId], ["far", remote.id]] as const) {
    createSession(sessionId, projectId, { agentRuntimeType: "pi", sourceId: source });
    new Sessions(state.nodes).submit(sessionId, { op: "prompt", content: text, clientId: `${sessionId}-p` });
  }
  const local = useFakeNode(state);
  await drainCommands(state);
  expect(ops(local.sent)).toEqual([["session.prompt", "local"]]);
  // The remote node is not connected: its session's work waits in the outbox.
  expect(new Sessions(state.nodes).get("far")?.placement).toEqual({ available: false, nodeId: "remote", nodeName: "Remote", path: "/remote/targets" });
  // Abort calls the node directly, never queued: it fails while the node is not connected.
  await expect(new Sessions(state.nodes).abort("far")).rejects.toThrow("Node unavailable");

  const far = useFakeNode(state, "remote");
  await drainCommands(state);
  expect(ops(far.sent)).toEqual([["session.prompt", "far"]]);
  expect(new Sessions(state.nodes).get("far")?.placement).toMatchObject({ available: true, nodeId: "remote" });
  await new Sessions(state.nodes).abort("far");
  await new Sessions(state.nodes).abort("local");
  expect(far.sent.at(-1)).toEqual({ op: "session.abort", sessionId: "far" });
  expect(local.sent.at(-1)).toEqual({ op: "session.abort", sessionId: "local" });
  expect([far.sent.length, local.sent.length]).toEqual([2, 2]);
}));


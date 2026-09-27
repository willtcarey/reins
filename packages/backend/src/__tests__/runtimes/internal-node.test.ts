import { test, expect, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { nodeRuntimesForTesting, startNode } from "@reins/node/node";
import { connectNode } from "@reins/node/node-connection";
import { createLoopbackPair, APPLICATION_ERROR, ATTACHMENT_CHUNK_BYTES, MAX_ATTACHMENT_BYTES } from "@reins/node/protocol";
import { createServerTransport } from "../../node-transport/server-peer.js";
import { Database } from "bun:sqlite";
import { setDb } from "../../db.js";
import { runMigrations } from "../../migrations.js";
import { createProject } from "../../project-store.js";
import { createSource, internalSource } from "../../node-store.js";
import { createSession } from "../../session-store.js";
import { storeSessionAttachment } from "../../session-attachments-store.js";
import { nodeSessionTask, openNodeStorage, setNodeDb } from "@reins/node/storage";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { insertEntry } from "@earendil-works/pi-agent-core/harness/session";
import { createServerState } from "../helpers/server-state.js";
import { internalNodeServer, provisionForSession } from "../../runtimes/internal-node.js";
import { internalNodeFor, stopInternalNode } from "../helpers/loopback-node.js";
import { createTask, updateTask } from "../../task-store.js";
import { createNewSession } from "../../runtimes/session-manager.js";
import { workForSession } from "../../models/node-command-projection.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { registerPiProvider, unregisterPiProvider } from "../../runtimes/pi/factory.js";
import { setApiKeyCredential } from "../../auth-credentials-store.js";
import { setSetting } from "../../settings-store.js";
import { getSession } from "../../session-store.js";
import { dispatcherFor, NodeCommandDispatcher } from "../../models/node-command-dispatcher.js";

test("internal node fetches attachments only for sessions it owns or would host, and reports commits only for sessions it owns", async () => {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON"); setDb(db); runMigrations(db);
  const nodeDb = new Database(":memory:");
  setNodeDb(nodeDb);
  const state = createServerState();
  try {
    const project = createProject("a", "/tmp/a");
    const source = internalSource(project.id);
    createSession("owned", project.id, { agentRuntimeType: "pi", sourceId: source.id, storageOwner: "internal-node" });
    createSession("legacy", project.id, { agentRuntimeType: "pi", sourceId: source.id });
    const node = internalNodeFor(state);
    const image = (sessionId: string) => {
      const stored = storeSessionAttachment(sessionId, { data: new Uint8Array([1, 2, 3]), mimeType: "image/png" });
      return { type: "image" as const, attachmentId: stored.id, mimeType: "image/png" as const, byteSize: 3, sha256: stored.sha256 };
    };
    const prompt = (sessionId: string, content: ReturnType<typeof image>[]) =>
      node.send({ op: "session.prompt", sessionId, clientId: `input-${sessionId}`, content }, provisionForSession(sessionId).binding);
    for (const sessionId of ["owned", "legacy"]) {
      await node.send({ op: "session.provision", sessionId, sourceId: source.id, configuration: { model: null, thinkingLevel: null, task: null } }, provisionForSession(sessionId).binding);
    }

    const owned = image("owned");
    // A trailing missing ref stops the prompt before Pi opens, after the first image is cached.
    expect(await prompt("owned", [owned, { ...owned, attachmentId: "missing" }]))
      .toMatchObject({ ok: false, error: { code: "invalid_request", message: "Attachment unavailable: missing" } });
    expect(nodeDb.query("SELECT data FROM node_attachments WHERE attachment_id = ?").get(owned.attachmentId))
      .toEqual({ data: Buffer.from([1, 2, 3]) });

    // A session another node owns is not readable by this one.
    db.query("INSERT INTO nodes (id, name) VALUES ('remote', 'Remote')").run();
    const remote = createSource(project.id, "remote", "/tmp/remote-a");
    createSession("foreign", project.id, { agentRuntimeType: "pi", sourceId: remote.id, storageOwner: "internal-node" });
    const foreignBinding = { sourceId: remote.id, cwd: "/tmp/remote-a", createdAt: getSession("foreign")!.created_at, parentSessionId: null };
    await node.send({ op: "session.provision", sessionId: "foreign", sourceId: remote.id, configuration: { model: null, thinkingLevel: null, task: null } }, foreignBinding);
    expect(await node.send({ op: "session.prompt", sessionId: "foreign", clientId: "input-foreign", content: [image("foreign")] }, foreignBinding))
      .toMatchObject({ ok: false, error: { code: "invalid_request", message: "Attachment fetch failed: Node session unavailable: foreign" } });

    nodeDb.query("INSERT INTO session_outbox(session_id,kind,start_seq,payload) VALUES('legacy','committed',1,'[]')").run();
    await node.send({ op: "session.provision", sessionId: "legacy", sourceId: source.id, configuration: { model: null, thinkingLevel: null, task: null } }, provisionForSession("legacy").binding);
    // Refused as not_owner: the node drops the report with its copy instead of retrying it.
    for (let i = 0; i < 200 && nodeDb.query("SELECT 1 FROM sessions WHERE id = 'legacy'").get(); i++) await Bun.sleep(5);
    expect(nodeDb.query("SELECT COUNT(*) n FROM session_outbox").get()).toEqual({ n: 0 });
    expect(nodeDb.query("SELECT 1 FROM sessions WHERE id = 'legacy'").get()).toBeNull();
    expect(db.query("SELECT harness_next_seq FROM sessions WHERE id = 'legacy'").get()).toEqual({ harness_next_seq: 1 });
    expect(db.query("SELECT COUNT(*) n FROM node_session_watermarks").get()).toEqual({ n: 0 });
  } finally { stopInternalNode(state); setNodeDb(); nodeDb.close(); setDb(new Database(":memory:")); db.close(); }
});

test("internal link delivers committed batches larger than a 1 MiB frame byte-for-byte", async () => {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON"); setDb(db); runMigrations(db);
  const nodeDb = new Database(":memory:");
  setNodeDb(nodeDb);
  const state = createServerState();
  try {
    const project = createProject("a", "/tmp/a");
    const source = internalSource(project.id);
    createSession("owned", project.id, { agentRuntimeType: "pi", sourceId: source.id, storageOwner: "internal-node" });
    const node = internalNodeFor(state);
    const provision = () => node.send({ op: "session.provision", sessionId: "owned", sourceId: source.id, configuration: { model: null, thinkingLevel: null, task: null } }, provisionForSession("owned").binding);
    await provision();
    const storage = await openNodeStorage(nodeDb, "owned", async () => { throw new Error("offline"); });
    await storage.commit([insertEntry({ id: "root", parentId: null, type: "custom", customType: "note", data: { text: "é".repeat(700_000) } })], BACKGROUND_CONTEXT);
    await storage.close(BACKGROUND_CONTEXT);
    const { payload: exact } = nodeDb.query<{ payload: string }, []>("SELECT payload FROM session_outbox").get()!;
    expect(Buffer.byteLength(exact)).toBeGreaterThan(1_048_576);

    await provision(); // delivery attempt over the live link
    expect(nodeDb.query("SELECT COUNT(*) n FROM session_outbox").get()).toEqual({ n: 0 });
    // The watermark remembers the applied batch's start and the hash of its exact bytes.
    expect(db.query("SELECT commit_start_seq, commit_sha256 FROM node_session_watermarks WHERE session_id = 'owned'").get())
      .toEqual({ commit_start_seq: 1, commit_sha256: createHash("sha256").update(exact).digest("hex") });
  } finally { stopInternalNode(state); setNodeDb(); nodeDb.close(); setDb(new Database(":memory:")); db.close(); }
});

test("node session events reach browsers and durable lifecycle reports drive activity, reporting a child to its parent once", async () => {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON"); setDb(db); runMigrations(db);
  const nodeDb = new Database(":memory:");
  setNodeDb(nodeDb);
  const dir = mkdtempSync(join(tmpdir(), "reins-node-events-"));
  const provider = fauxProvider({ provider: "node-events-faux", models: [{ id: "fake", contextWindow: 200_000, maxTokens: 1_000 }] });
  provider.setResponses([fauxAssistantMessage("Child answer"), fauxAssistantMessage("Parent heard")]);
  registerPiProvider(provider.provider);
  setApiKeyCredential(provider.provider.id, "test-key");
  setSetting("default_model", { provider: provider.provider.id, modelId: "fake", runtimeType: "pi", thinkingLevel: "low" });
  const state = createServerState();
  const sent: Array<{ type: string; sessionId?: string; event?: { type: string } }> = [];
  state.clients.add({ ws: { send: data => { sent.push(JSON.parse(data)); return 0; } } });
  // The parent is at rest on the server: the child's report moves it onto the node, where it is steered.
  const parentInputs = () => db.query<{ message_json: string }, []>("SELECT message_json FROM session_messages WHERE session_id = 'parent' AND role = 'reinsInput'").all()
    .map(row => JSON.parse(row.message_json).message);
  try {
    const project = createProject("Events", dir);
    const source = internalSource(project.id);
    createSession("parent", project.id, { agentRuntimeType: "pi", sourceId: source.id, modelProvider: provider.provider.id, modelId: "fake" });
    createSession("child", project.id, { agentRuntimeType: "pi", sourceId: source.id, storageOwner: "internal-node", parentSessionId: "parent" });
    const node = internalNodeFor(state);
    const binding = provisionForSession("child").binding;
    await node.send({ op: "session.provision", sessionId: "child", sourceId: source.id,
      configuration: { model: { provider: provider.provider.id, modelId: "fake" }, thinkingLevel: null, task: null } }, binding);
    await node.send({ op: "session.prompt", sessionId: "child", clientId: "c", content: [{ type: "text", text: "Go" }] }, binding);
    await (await nodeRuntimesForTesting(node).open("child", binding)).waitForIdle();
    for (let i = 0; i < 400 && parentInputs().length === 0; i++) await Bun.sleep(5);

    expect(parentInputs()).toEqual([expect.objectContaining({ content: [{ type: "text", text: "Child answer" }], reinsId: expect.any(String), metadata: { sourceSessionId: "child" } })]);
    expect(getSession("parent")?.storage_owner).toBe("internal-node");
    expect(sent.some(message => message.type === "event" && message.sessionId === "child" && message.event?.type === "agent_end")).toBe(true);
    expect(sent.filter(message => message.type === "session_updated" && message.sessionId === "child").length).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < 100 && getSession("child")?.activity_state !== null; i++) await Bun.sleep(5);
    expect(getSession("child")).toMatchObject({ activity_state: null, model_provider: provider.provider.id, model_id: "fake", thinking_level: "off" });
    for (let i = 0; i < 100 && db.query("SELECT 1 FROM node_command_outbox").get(); i++) await Bun.sleep(5);
    expect(db.query("SELECT report_kind, settlement_count FROM node_session_watermarks WHERE session_id = 'child'").get()).toEqual({ report_kind: "settled", settlement_count: 1 });
    expect(nodeDb.query("SELECT COUNT(*) n FROM session_outbox").get()).toEqual({ n: 0 });
    expect(parentInputs()).toHaveLength(1);
    await nodeRuntimesForTesting(node).close("child");
    for (let i = 0; i < 400 && getSession("parent")?.activity_state === "running"; i++) await Bun.sleep(5);
    await nodeRuntimesForTesting(node).close("parent");
  } finally {
    dispatcherFor(state).stop(); stopInternalNode(state); unregisterPiProvider(provider.provider.id); setNodeDb(); nodeDb.close();
    setDb(new Database(":memory:")); db.close(); rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);

test("tool-result images are committed and reach browsers over the internal link as references to one server attachment under the node's ID", async () => {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON"); setDb(db); runMigrations(db);
  const nodeDb = new Database(":memory:");
  setNodeDb(nodeDb);
  const dir = mkdtempSync(join(tmpdir(), "reins-node-tool-image-"));
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  writeFileSync(join(dir, "pixel.png"), png);
  const provider = fauxProvider({ provider: "node-tool-image-faux", models: [{ id: "fake", input: ["text", "image"], contextWindow: 200_000, maxTokens: 1_000 }] });
  provider.setResponses([fauxAssistantMessage([fauxToolCall("read", { path: "pixel.png" }, { id: "read" })], { stopReason: "toolUse" }), fauxAssistantMessage("Seen")]);
  registerPiProvider(provider.provider);
  setApiKeyCredential(provider.provider.id, "test-key");
  const state = createServerState();
  const sent: Array<{ type: string; sessionId?: string; event?: { type: string } }> = [];
  state.clients.add({ ws: { send: data => { sent.push(JSON.parse(data)); return 0; } } });
  const warn = spyOn(console, "warn");
  try {
    // Record the order in which the server stores attachments and applies replicated transcript entries.
    db.exec(`CREATE TEMP TABLE applied (seq INTEGER PRIMARY KEY AUTOINCREMENT, what TEXT NOT NULL);
      CREATE TEMP TRIGGER attachment_applied AFTER INSERT ON session_attachments BEGIN INSERT INTO applied(what) VALUES ('attachment:' || NEW.id); END;
      CREATE TEMP TRIGGER message_applied AFTER INSERT ON session_messages BEGIN INSERT INTO applied(what) VALUES ('message:' || NEW.message_json); END;`);
    const project = createProject("Tool image", dir);
    const source = internalSource(project.id);
    createSession("owned", project.id, { agentRuntimeType: "pi", sourceId: source.id, storageOwner: "internal-node" });
    const node = internalNodeFor(state);
    const binding = provisionForSession("owned").binding;
    await node.send({ op: "session.provision", sessionId: "owned", sourceId: source.id,
      configuration: { model: { provider: provider.provider.id, modelId: "fake" }, thinkingLevel: null, task: null } }, binding);
    await node.send({ op: "session.prompt", sessionId: "owned", clientId: "c", content: [{ type: "text", text: "Read it" }] }, binding);
    await (await nodeRuntimesForTesting(node).open("owned", binding)).waitForIdle();
    for (let i = 0; i < 200 && !sent.some(message => message.event?.type === "agent_end"); i++) await Bun.sleep(5);
    for (let i = 0; i < 100 && nodeDb.query("SELECT 1 FROM session_outbox").get(); i++) await Bun.sleep(5);

    const rows = db.query<{ id: string; mime_type: string; data: Buffer; sha256: string }, []>("SELECT id, mime_type, data, sha256 FROM session_attachments WHERE session_id = 'owned'").all();
    expect(rows).toHaveLength(1);
    // The server stored the upload under the ID the node assigned (and cached the bytes under).
    expect(nodeDb.query("SELECT attachment_id FROM node_attachments WHERE session_id = 'owned'").all()).toEqual([{ attachment_id: rows[0]!.id }]);
    expect(rows[0]!.mime_type).toBe("image/png");
    const applied = db.query<{ what: string }, []>("SELECT what FROM applied ORDER BY seq").all().map(row => row.what);
    const firstReference = applied.findIndex(what => what.startsWith("message:") && what.includes(rows[0]!.id));
    expect(firstReference).toBeGreaterThan(applied.indexOf(`attachment:${rows[0]!.id}`));
    expect(applied.indexOf(`attachment:${rows[0]!.id}`)).toBeGreaterThanOrEqual(0);
    expect(createHash("sha256").update(rows[0]!.data).digest("hex")).toBe(rows[0]!.sha256);
    const events = sent.filter(message => message.type === "event" && message.sessionId === "owned").map(message => message.event!);
    const images = events.flatMap(event => JSON.stringify(event).match(/"type":"image"[^}]*/g) ?? []);
    expect(images.length).toBeGreaterThan(2);
    expect(images.every(image => image.includes(`"attachmentId":"${rows[0]!.id}"`) && !image.includes('"data"'))).toBe(true);
    expect(events.map(event => event.type)).toEqual(expect.arrayContaining(["tool_execution_end", "turn_end", "agent_end"]));
    expect(warn.mock.calls.filter(([message]) => String(message).includes("Dropped"))).toEqual([]);
    // Pi committed the reference, so the server replica's transcript holds no image bytes either.
    const transcript = JSON.stringify(db.query("SELECT message_json FROM session_messages WHERE session_id = 'owned'").all());
    expect(transcript).toContain(rows[0]!.id);
    expect(transcript).not.toContain(rows[0]!.data.toString("base64"));
    await nodeRuntimesForTesting(node).close("owned");
  } finally {
    warn.mockRestore(); stopInternalNode(state); unregisterPiProvider(provider.provider.id); setNodeDb(); nodeDb.close();
    setDb(new Database(":memory:")); db.close(); rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);

test("attachment.store over a 1 MiB-capped link uploads chunks the server verifies and stores under the node's ID, idempotently, for node-owned sessions", async () => {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON"); setDb(db); runMigrations(db);
  const nodeDb = new Database(":memory:");
  setNodeDb(nodeDb);
  const state = createServerState();
  const node = startNode();
  const [serverEnd, nodeEnd] = createLoopbackPair();
  const server = createServerTransport(serverEnd, internalNodeServer(state));
  const connection = connectNode(node, nodeEnd, "capped");
  const calls: number[] = [];
  serverEnd.onmessage = data => { if (String(data).includes("attachment.store")) calls.push(1); server.receive(data); };
  serverEnd.onclose = server.close;
  nodeEnd.onmessage = connection.receive; nodeEnd.onclose = connection.close;
  try {
    const project = createProject("Store", "/tmp/store");
    const source = internalSource(project.id);
    createSession("owned", project.id, { agentRuntimeType: "pi", sourceId: source.id, storageOwner: "internal-node" });
    createSession("legacy", project.id, { agentRuntimeType: "pi", sourceId: source.id });
    createSession("owned-2", project.id, { agentRuntimeType: "pi", sourceId: source.id, storageOwner: "internal-node" });
    const bytes = new Uint8Array(ATTACHMENT_CHUNK_BYTES * 2 + 5).map((_, i) => (i * 7) % 256);
    const upload = { sessionId: "owned", attachmentId: "att_node-1", mimeType: "image/png", byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), filename: "shot.png", width: 4, height: 3, data: bytes };
    const count = () => db.query("SELECT COUNT(*) n FROM session_attachments").get();

    await connection.storeAttachment(upload);
    expect(calls).toHaveLength(3);
    // Stored under exactly the node-assigned ID.
    expect(db.query("SELECT session_id, data, width, height, filename FROM session_attachments WHERE id = 'att_node-1'").get())
      .toEqual({ session_id: "owned", data: Buffer.from(bytes), width: 4, height: 3, filename: "shot.png" });
    // A replay (e.g. after a lost reply) is answered from the stored row without bytes crossing again.
    await connection.storeAttachment(upload);
    expect(calls).toHaveLength(4);
    expect(count()).toEqual({ n: 1 });
    // Identical bytes under another node ID are stored under that ID too: both references resolve.
    await connection.storeAttachment({ ...upload, attachmentId: "att_node-2" });
    expect(db.query("SELECT id FROM session_attachments WHERE session_id = 'owned' AND data IS NOT NULL ORDER BY id").all())
      .toEqual([{ id: "att_node-1" }, { id: "att_node-2" }]);

    const small = new Uint8Array([1, 2, 3]);
    const smallUpload = { sessionId: "owned", attachmentId: "att_small", mimeType: "image/png", byteSize: 3, sha256: createHash("sha256").update(small).digest("hex"), data: small };
    // The same ID with different content is divergence and changes nothing.
    await expect(connection.storeAttachment({ ...smallUpload, attachmentId: "att_node-1" })).rejects.toMatchObject({ code: APPLICATION_ERROR, message: "Attachment att_node-1 is already stored with different content" });
    await expect(connection.storeAttachment({ ...smallUpload, sessionId: "owned-2", attachmentId: "att_node-1", sha256: upload.sha256, byteSize: bytes.length, data: bytes }))
      .rejects.toMatchObject({ code: APPLICATION_ERROR, message: "Attachment ID already in use: att_node-1" });
    await expect(connection.storeAttachment({ ...smallUpload, sha256: "0".repeat(64) })).rejects.toMatchObject({ code: APPLICATION_ERROR, message: "Attachment checksum mismatch: att_small" });
    await expect(connection.storeAttachment({ ...smallUpload, byteSize: 4 })).rejects.toMatchObject({ code: APPLICATION_ERROR, message: expect.stringContaining("chunk size mismatch") });
    await expect(connection.storeAttachment({ ...smallUpload, byteSize: MAX_ATTACHMENT_BYTES + 1 })).rejects.toMatchObject({ code: -32602 });
    await expect(connection.storeAttachment({ ...smallUpload, mimeType: "image/tiff" })).rejects.toMatchObject({ code: APPLICATION_ERROR, message: "Unsupported image type: image/tiff" });
    await expect(connection.storeAttachment({ ...smallUpload, sessionId: "legacy" })).rejects.toMatchObject({ code: APPLICATION_ERROR, message: "Node session unavailable: legacy" });
    await expect(connection.storeAttachment({ ...smallUpload, sessionId: "unknown" })).rejects.toMatchObject({ code: APPLICATION_ERROR, message: "Session not found: unknown" });
    expect(count()).toEqual({ n: 2 });
  } finally {
    serverEnd.close(); node.stop(); setNodeDb(); nodeDb.close();
    setDb(new Database(":memory:")); db.close();
  }
});

const lane = (target: Database, sessionId: string) => target.query<{ value_json: string }, [string]>(
  "SELECT value_json FROM pi_values WHERE session_id = ? AND namespace = 'pi.lane.config'").get(sessionId);

test("session creation freezes model, thinking level and task into the provision; later default_model and task edits do not reach the node", async () => {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON"); setDb(db); runMigrations(db);
  const nodeDb = new Database(":memory:");
  setNodeDb(nodeDb);
  // Pi creates the lane at provision, so the node's model registry must know the frozen models.
  const providers = [fauxProvider({ provider: "default-provider", models: [{ id: "default-model" }] }), fauxProvider({ provider: "p", models: [{ id: "m" }] })];
  for (const provider of providers) registerPiProvider(provider.provider);
  const state = createServerState();
  try {
    const project = createProject("Config", "/tmp/config");
    const task = createTask(project.id, "Fix login", "Users can't log in", "task/fix-login");
    // Created before any default exists: no model is resolved, and none is filled in later.
    const unresolved = createNewSession(state, project.id, project.path);
    setSetting("default_model", { provider: "default-provider", modelId: "default-model", runtimeType: "pi", thinkingLevel: "low" });
    const defaulted = createNewSession(state, project.id, project.path, { taskId: task.id });
    const override = createNewSession(state, project.id, project.path, { model: { provider: "p", modelId: "m" }, thinkingLevel: "high" });

    setSetting("default_model", { provider: "later-provider", modelId: "later-model", runtimeType: "pi", thinkingLevel: "max" });
    updateTask(task.id, { title: "Renamed", description: "Edited later" });
    await new NodeCommandDispatcher(state).drain();

    const configuration = (sessionId: string) => {
      const command = workForSession(sessionId)?.command;
      return command?.op === "session.provision" ? command.configuration : undefined;
    };
    expect(configuration(unresolved.id)).toEqual({ model: null, thinkingLevel: null, task: null });
    expect(configuration(defaulted.id)).toEqual({ model: { provider: "default-provider", modelId: "default-model" }, thinkingLevel: "low",
      task: { title: "Fix login", description: "Users can't log in", branchName: "task/fix-login" } });
    expect(configuration(override.id)).toEqual({ model: { provider: "p", modelId: "m" }, thinkingLevel: "high", task: null });
    // The server row holds the same frozen selection.
    expect(getSession(defaulted.id)).toMatchObject({ model_provider: "default-provider", model_id: "default-model", thinking_level: "low" });
    expect(getSession(unresolved.id)).toMatchObject({ model_provider: null, model_id: null, thinking_level: "off" });

    for (const id of [unresolved.id, defaulted.id, override.id]) expect(workForSession(id)?.state).toBe("admitted");
    // The node stores the task snapshot with its session and the model in Pi's lane (replicated to the server).
    expect(JSON.parse(lane(nodeDb, defaulted.id)!.value_json)).toMatchObject({ model: { provider: "default-provider", modelId: "default-model" }, thinkingLevel: "low" });
    expect(JSON.parse(lane(nodeDb, override.id)!.value_json)).toMatchObject({ model: { provider: "p", modelId: "m" }, thinkingLevel: "high" });
    expect(lane(nodeDb, unresolved.id)).toBeNull();
    expect(nodeSessionTask(nodeDb, defaulted.id)).toEqual({ title: "Fix login", description: "Users can't log in", branchName: "task/fix-login" });
    expect(nodeSessionTask(nodeDb, override.id)).toBeNull();
    for (let i = 0; i < 100 && nodeDb.query("SELECT 1 FROM session_outbox").get(); i++) await Bun.sleep(5);
    expect(lane(db, defaulted.id)).toEqual(lane(nodeDb, defaulted.id));
  } finally {
    for (const provider of providers) unregisterPiProvider(provider.provider.id);
    stopInternalNode(state); setNodeDb(); nodeDb.close(); setDb(new Database(":memory:")); db.close();
  }
});

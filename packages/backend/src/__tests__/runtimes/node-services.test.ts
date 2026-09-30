import { test, expect, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { nodeRuntimesForTesting, startNode } from "@reins/node/node";
import { connectNode } from "@reins/node/node-connection";
import { APPLICATION_ERROR, ATTACHMENT_CHUNK_BYTES, MAX_ATTACHMENT_BYTES } from "@reins/node-protocol";
import { createLoopbackPair } from "@reins/node-protocol/testing";
import { Database } from "bun:sqlite";
import { setDb } from "../../db.js";
import { runMigrations } from "../../migrations.js";
import { createProject } from "../../project-store.js";
import { createSource, defaultSource } from "../../node-store.js";
import { createSession } from "../../session-store.js";
import { nodeServerServices } from "../../runtimes/node-services.js";
import { storeSessionAttachment } from "../../session-attachments-store.js";
import { createServerState } from "../helpers/server-state.js";
import { loopbackNodeFor, openingTarget, stopLoopbackNode } from "../helpers/loopback-node.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { registerPiProvider, unregisterPiProvider } from "../helpers/pi-providers.js";
import { setApiKeyCredential } from "../../auth-credentials-store.js";
import { setSetting } from "../../settings-store.js";
import { getSession } from "../../session-store.js";

/** What the session's opening commands carry (its binding, task snapshot and lane seed), as delivery resolves it. */

test("a node fetches attachments only for sessions whose source is on it", async () => {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON"); setDb(db); runMigrations(db);
  const state = createServerState();
  try {
    const project = createProject("a", "/tmp/a");
    createSession("owned", project.id, { agentRuntimeType: "pi", sourceId: defaultSource(project.id)!.id });
    db.query("INSERT INTO nodes (id, name) VALUES ('remote', 'Remote')").run();
    createSession("foreign", project.id, { agentRuntimeType: "pi", sourceId: createSource(project.id, "remote", "/tmp/remote-a").id });
    const node = loopbackNodeFor(state);
    const image = (sessionId: string) => {
      const stored = storeSessionAttachment(sessionId, { data: new Uint8Array([1, 2, 3]), mimeType: "image/png" });
      return { type: "image" as const, attachmentId: stored.id, mimeType: "image/png" as const, byteSize: 3, sha256: stored.sha256 };
    };
    const prompt = (sessionId: string, content: ReturnType<typeof image>[]) =>
      node.prompt({ ...openingTarget(sessionId), sessionId, clientId: `input-${sessionId}`, content, sourceSessionId: null });

    // The first image is fetched; a trailing missing ref stops the prompt before Pi opens.
    const owned = image("owned");
    await expect(prompt("owned", [owned, { ...owned, attachmentId: "missing" }]))
      .rejects.toMatchObject({ error: { code: "invalid_request", message: "Attachment unavailable: missing" } });
    // A session on another node's source is not readable by this one.
    await expect(prompt("foreign", [image("foreign")]))
      .rejects.toMatchObject({ error: { code: "invalid_request", message: "Attachment fetch failed: Node session unavailable: foreign" } });
  } finally { await stopLoopbackNode(state); setDb(new Database(":memory:")); db.close(); }
});

test("node session events reach browsers and durable lifecycle reports drive activity, reporting a child to its parent once", async () => {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON"); setDb(db); runMigrations(db);
  const dir = mkdtempSync(join(tmpdir(), "reins-node-events-"));
  const provider = fauxProvider({ provider: "node-events-faux", models: [{ id: "fake", contextWindow: 200_000, maxTokens: 1_000 }] });
  provider.setResponses([fauxAssistantMessage("Child answer"), fauxAssistantMessage("Parent heard")]);
  registerPiProvider(provider.provider);
  setApiKeyCredential(provider.provider.id, "test-key");
  setSetting("default_model", { provider: provider.provider.id, modelId: "fake", runtimeType: "pi", thinkingLevel: "low" });
  const state = createServerState();
  const sent: Array<{ type: string; sessionId?: string; event?: { type: string } }> = [];
  state.clients.add({ ws: { send: data => { sent.push(JSON.parse(data)); return 0; } } });
  // The child's settlement steers its parent on the parent's node.
  const parentInputs = () => db.query<{ message_json: string }, []>("SELECT message_json FROM session_messages WHERE session_id = 'parent' AND role = 'reinsInput'").all()
    .map(row => JSON.parse(row.message_json).message);
  try {
    const project = createProject("Events", dir);
    const source = defaultSource(project.id)!;
    createSession("parent", project.id, { agentRuntimeType: "pi", sourceId: source.id, modelProvider: provider.provider.id, modelId: "fake" });
    createSession("child", project.id, { agentRuntimeType: "pi", sourceId: source.id, parentSessionId: "parent", modelProvider: provider.provider.id, modelId: "fake" });
    const node = loopbackNodeFor(state);
    await node.prompt({ ...openingTarget("child"), sessionId: "child", clientId: "c", content: [{ type: "text", text: "Go" }], sourceSessionId: null });
    await (await nodeRuntimesForTesting(node).open("child", openingTarget("child"))).waitForIdle();
    for (let i = 0; i < 400 && parentInputs().length === 0; i++) await Bun.sleep(5);

    expect(parentInputs()).toEqual([expect.objectContaining({ content: [{ type: "text", text: "Child answer" }], reinsId: expect.any(String), metadata: { sourceSessionId: "child" } })]);
    expect(sent.some(message => message.type === "event" && message.sessionId === "child" && message.event?.type === "agent_end")).toBe(true);
    expect(sent.filter(message => message.type === "session_updated" && message.sessionId === "child").length).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < 100 && getSession("child")?.activity_state !== null; i++) await Bun.sleep(5);
    expect(getSession("child")).toMatchObject({ activity_state: null, model_provider: provider.provider.id, model_id: "fake", thinking_level: "off" });
    for (let i = 0; i < 100 && db.query("SELECT 1 FROM node_command_outbox").get(); i++) await Bun.sleep(5);
    expect(db.query("SELECT run_id, settlement_count FROM sessions WHERE id = 'child'").get()).toEqual({ run_id: null, settlement_count: 1 });
    expect(parentInputs()).toHaveLength(1);
    await nodeRuntimesForTesting(node).close("child");
    for (let i = 0; i < 400 && getSession("parent")?.activity_state === "running"; i++) await Bun.sleep(5);
    await nodeRuntimesForTesting(node).close("parent");
  } finally {
    state.nodes.close(); await stopLoopbackNode(state); unregisterPiProvider(provider.provider.id);
    setDb(new Database(":memory:")); db.close(); rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);

test("tool-result images are committed and reach browsers over the node link as references to one server attachment under the node's ID", async () => {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON"); setDb(db); runMigrations(db);
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
    // Record the order in which the server stores attachments and commits transcript entries.
    db.exec(`CREATE TEMP TABLE applied (seq INTEGER PRIMARY KEY AUTOINCREMENT, what TEXT NOT NULL);
      CREATE TEMP TRIGGER attachment_applied AFTER INSERT ON session_attachments BEGIN INSERT INTO applied(what) VALUES ('attachment:' || NEW.id); END;
      CREATE TEMP TRIGGER message_applied AFTER INSERT ON session_messages BEGIN INSERT INTO applied(what) VALUES ('message:' || NEW.message_json); END;`);
    const project = createProject("Tool image", dir);
    const source = defaultSource(project.id)!;
    createSession("owned", project.id, { agentRuntimeType: "pi", sourceId: source.id, modelProvider: provider.provider.id, modelId: "fake" });
    const node = loopbackNodeFor(state);
    await node.prompt({ ...openingTarget("owned"), sessionId: "owned", clientId: "c", content: [{ type: "text", text: "Read it" }], sourceSessionId: null });
    await (await nodeRuntimesForTesting(node).open("owned", openingTarget("owned"))).waitForIdle();
    for (let i = 0; i < 200 && !sent.some(message => message.event?.type === "agent_end"); i++) await Bun.sleep(5);

    const rows = db.query<{ id: string; mime_type: string; data: Buffer; sha256: string }, []>("SELECT id, mime_type, data, sha256 FROM session_attachments WHERE session_id = 'owned'").all();
    expect(rows).toHaveLength(1);
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
    // Pi committed the reference, so the server's transcript holds no image bytes either.
    const transcript = JSON.stringify(db.query("SELECT message_json FROM session_messages WHERE session_id = 'owned'").all());
    expect(transcript).toContain(rows[0]!.id);
    expect(transcript).not.toContain(rows[0]!.data.toString("base64"));
    await nodeRuntimesForTesting(node).close("owned");
  } finally {
    warn.mockRestore(); await stopLoopbackNode(state); unregisterPiProvider(provider.provider.id);
    setDb(new Database(":memory:")); db.close(); rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);

test("a node's session events reach every browser as frames built around the node's exact bytes; its reports are refused for sessions not on it", () => {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON"); setDb(db); runMigrations(db);
  const state = createServerState();
  const browsers: string[][] = [[], []];
  for (const frames of browsers) state.clients.add({ ws: { send: data => { frames.push(data); return 0; } } });
  try {
    const project = createProject("Relay", "/tmp/relay");
    const source = defaultSource(project.id)!;
    createSession("owned", project.id, { agentRuntimeType: "pi", sourceId: source.id });
    db.query("INSERT INTO nodes (id, name) VALUES ('remote', 'Remote')").run();
    const remote = createSource(project.id, "remote", "/tmp/remote-relay");
    createSession("foreign", project.id, { agentRuntimeType: "pi", sourceId: remote.id });
    const handlers = nodeServerServices(state).handlers("internal");

    // Not a runtime event, an inline image and a non-canonical number: the server relays it untouched.
    const raw = '{"type":"not_a_runtime_event","content":[{"type":"image","data":"AAAA"}],"n":1.50}';
    void handlers.event({ sessionId: "owned", seq: 3, missed: 0, emittedAt: 1_700_000_000_000, event: raw });
    const frame = `{"event":${raw},"type":"event","sessionId":"owned","projectId":${project.id},"seq":3,"emittedAt":1700000000000}`;
    expect(browsers).toEqual([[frame], [frame]]);
    // The envelope follows the payload, so a payload cannot rewrite it.
    void handlers.event({ sessionId: "owned", seq: 4, missed: 0, emittedAt: 0, event: '{"type":"agent_start"},"sessionId":"foreign","projectId":0,"seq":99' });
    expect(JSON.parse(browsers[0]!.at(-1)!)).toEqual({ event: { type: "agent_start" }, type: "event", sessionId: "owned", projectId: project.id, seq: 4, emittedAt: 0 });

    // Fencing reads the session's live source: a session on another node, or moved away, is not this node's.
    const notOwner = { data: { code: "not_owner", message: expect.any(String), retryable: false } };
    expect(() => handlers.event({ sessionId: "foreign", seq: 1, missed: 0, emittedAt: 0, event: raw })).toThrow(expect.objectContaining(notOwner));
    expect(() => handlers.event({ sessionId: "missing", seq: 1, missed: 0, emittedAt: 0, event: raw })).toThrow("Session not found: missing");
    expect(() => handlers.started({ sessionId: "foreign", runId: "r" })).toThrow(expect.objectContaining(notOwner));
    expect(() => handlers.settled({ sessionId: "foreign", runId: "r", status: "completed", metadata: { model: null, thinkingLevel: null }, tipId: null }))
      .toThrow(expect.objectContaining(notOwner));
    db.query("UPDATE sessions SET source_id = ? WHERE id = 'owned'").run(remote.id);
    expect(() => handlers.event({ sessionId: "owned", seq: 5, missed: 0, emittedAt: 0, event: raw })).toThrow(expect.objectContaining(notOwner));
    expect(() => handlers.started({ sessionId: "owned", runId: "r" })).toThrow(expect.objectContaining(notOwner));
    expect(browsers[0]).toHaveLength(2);
    expect(getSession("foreign")?.activity_state).toBeNull();
  } finally { state.nodes.close(); setDb(new Database(":memory:")); db.close(); }
});

test("attachment.store over a 1 MiB-capped link uploads chunks the server verifies and stores under the node's ID, idempotently, for sessions on the node", async () => {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON"); setDb(db); runMigrations(db);
  const state = createServerState();
  const node = startNode();
  const [serverEnd, nodeEnd] = createLoopbackPair();
  // Through the hub's accept path with the transport's default (1 MiB) frame cap.
  state.nodes.accept(serverEnd, {});
  const connection = connectNode(node, nodeEnd, "internal");
  const calls: number[] = [];
  const serve = serverEnd.onmessage!;
  serverEnd.onmessage = data => { if (String(data).includes("attachment.store")) calls.push(1); serve(data); };
  nodeEnd.onmessage = connection.receive; nodeEnd.onclose = connection.close;
  try {
    const project = createProject("Store", "/tmp/store");
    const source = defaultSource(project.id)!;
    createSession("owned", project.id, { agentRuntimeType: "pi", sourceId: source.id });
    db.query("INSERT INTO nodes (id, name) VALUES ('remote', 'Remote')").run();
    createSession("foreign", project.id, { agentRuntimeType: "pi", sourceId: createSource(project.id, "remote", "/tmp/remote-store").id });
    createSession("owned-2", project.id, { agentRuntimeType: "pi", sourceId: source.id });
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
    await expect(connection.storeAttachment({ ...smallUpload, sessionId: "foreign" })).rejects.toMatchObject({ code: APPLICATION_ERROR, message: "Node session unavailable: foreign" });
    await expect(connection.storeAttachment({ ...smallUpload, sessionId: "unknown" })).rejects.toMatchObject({ code: APPLICATION_ERROR, message: "Session not found: unknown" });
    expect(count()).toEqual({ n: 2 });
  } finally {
    serverEnd.close(); await node.shutdown();
    setDb(new Database(":memory:")); db.close();
  }
});

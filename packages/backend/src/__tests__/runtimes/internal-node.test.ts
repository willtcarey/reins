import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { setDb } from "../../db.js";
import { runMigrations } from "../../migrations.js";
import { createProject } from "../../project-store.js";
import { internalSource } from "../../node-store.js";
import { createSession } from "../../session-store.js";
import { storeSessionAttachment } from "../../session-attachments-store.js";
import { openNodeStorage, setNodeDb } from "@reins/node/storage";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { insertEntry } from "@earendil-works/pi-agent-core/harness/session";
import { createServerState } from "../helpers/server-state.js";
import { internalNodeFor, internalNodeServer, provisionForSession, stopInternalNode } from "../../runtimes/internal-node.js";
import { startNode } from "@reins/node/node";
import { connectNode } from "@reins/node/node-connection";
import { createLoopbackPair } from "@reins/node/protocol";
import { createServerTransport } from "../../node-transport/server-peer.js";
import { createTask } from "../../task-store.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { registerPiProvider, unregisterPiProvider } from "../../runtimes/pi/factory.js";
import { setApiKeyCredential } from "../../auth-credentials-store.js";
import { setSetting } from "../../settings-store.js";
import { getSession } from "../../session-store.js";
import { createRuntimeStub } from "../helpers/test-runtime-stub.js";
import { dispatcherFor } from "../../models/node-command-dispatcher.js";

test("internal node fetches attachments and reports commits over its link only for node-owned sessions", async () => {
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
      await node.send({ op: "session.provision", sessionId, sourceId: source.id }, provisionForSession(sessionId).binding);
    }

    const owned = image("owned");
    // A trailing missing ref stops the prompt before Pi opens, after the first image is cached.
    expect(await prompt("owned", [owned, { ...owned, attachmentId: "missing" }]))
      .toMatchObject({ ok: false, error: { code: "invalid_request", message: "Attachment unavailable: missing" } });
    expect(nodeDb.query("SELECT data FROM node_attachments WHERE attachment_id = ?").get(owned.attachmentId))
      .toEqual({ data: Buffer.from([1, 2, 3]) });

    expect(await prompt("legacy", [image("legacy")])).toMatchObject({ ok: false, error: {
      code: "invalid_request", message: "Attachment fetch failed: Node session unavailable: legacy" } });

    nodeDb.query("INSERT INTO session_outbox(session_id,kind,start_seq,payload) VALUES('legacy','committed',1,'[]')").run();
    await node.send({ op: "session.provision", sessionId: "legacy", sourceId: source.id }, provisionForSession("legacy").binding);
    expect(nodeDb.query("SELECT COUNT(*) n FROM session_outbox").get()).toEqual({ n: 1 });
    expect(db.query("SELECT COUNT(*) n FROM node_replica_receipts").get()).toEqual({ n: 0 });
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
    const provision = () => node.send({ op: "session.provision", sessionId: "owned", sourceId: source.id }, provisionForSession("owned").binding);
    await provision();
    const storage = await openNodeStorage(nodeDb, "owned", async () => { throw new Error("offline"); });
    await storage.commit([insertEntry({ id: "root", parentId: null, type: "custom", customType: "note", data: { text: "é".repeat(700_000) } })], BACKGROUND_CONTEXT);
    await storage.close(BACKGROUND_CONTEXT);
    const { payload: exact } = nodeDb.query<{ payload: string }, []>("SELECT payload FROM session_outbox").get()!;
    expect(Buffer.byteLength(exact)).toBeGreaterThan(1_048_576);

    await provision(); // delivery attempt over the live link
    expect(nodeDb.query("SELECT COUNT(*) n FROM session_outbox").get()).toEqual({ n: 0 });
    expect(db.query("SELECT writes_json FROM node_replica_receipts WHERE session_id = 'owned'").get()).toEqual({ writes_json: exact });
  } finally { stopInternalNode(state); setNodeDb(); nodeDb.close(); setDb(new Database(":memory:")); db.close(); }
});

test("node session events reach browsers and durable lifecycle reports drive activity, reporting a child to its parent once", async () => {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON"); setDb(db); runMigrations(db);
  const nodeDb = new Database(":memory:");
  setNodeDb(nodeDb);
  const dir = mkdtempSync(join(tmpdir(), "reins-node-events-"));
  const provider = fauxProvider({ provider: "node-events-faux", models: [{ id: "fake", contextWindow: 200_000, maxTokens: 1_000 }] });
  provider.setResponses([fauxAssistantMessage("Child answer")]);
  registerPiProvider(provider.provider);
  setApiKeyCredential(provider.provider.id, "test-key");
  setSetting("default_model", { provider: provider.provider.id, modelId: "fake", runtimeType: "pi", thinkingLevel: "low" });
  const state = createServerState();
  const sent: Array<{ type: string; sessionId?: string; event?: { type: string } }> = [];
  state.clients.add({ ws: { send: data => { sent.push(JSON.parse(data)); return 0; } } });
  const parent = createRuntimeStub();
  try {
    const project = createProject("Events", dir);
    const source = internalSource(project.id);
    createSession("parent", project.id, { agentRuntimeType: "pi", sourceId: source.id });
    state.sessions.set("parent", { id: "parent", runtime: parent.runtime, lastActivity: 0 });
    createSession("child", project.id, { agentRuntimeType: "pi", sourceId: source.id, storageOwner: "internal-node", parentSessionId: "parent" });
    const node = internalNodeFor(state);
    const binding = provisionForSession("child").binding;
    await node.send({ op: "session.provision", sessionId: "child", sourceId: source.id }, binding);
    await node.send({ op: "session.prompt", sessionId: "child", clientId: "c", content: [{ type: "text", text: "Go" }] }, binding);
    await (await node.open("child", binding)).waitForIdle();
    for (let i = 0; i < 200 && parent.steerCalls.length === 0; i++) await Bun.sleep(5);

    expect(parent.steerCalls).toEqual([[{ type: "text", text: "Child answer" }]]);
    expect(parent.steerOptions).toEqual([{ reinsId: expect.any(String), metadata: { sourceSessionId: "child" } }]);
    expect(sent.some(message => message.type === "event" && message.sessionId === "child" && message.event?.type === "agent_end")).toBe(true);
    expect(sent.filter(message => message.type === "session_updated" && message.sessionId === "child").length).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < 100 && getSession("child")?.activity_state !== null; i++) await Bun.sleep(5);
    expect(getSession("child")).toMatchObject({ activity_state: null, model_provider: provider.provider.id, model_id: "fake", thinking_level: "off" });
    for (let i = 0; i < 100 && db.query("SELECT 1 FROM node_command_outbox").get(); i++) await Bun.sleep(5);
    expect(db.query("SELECT kind FROM node_lifecycle_receipts WHERE session_id = 'child' ORDER BY kind").all()).toEqual([{ kind: "settled" }, { kind: "started" }]);
    expect(nodeDb.query("SELECT COUNT(*) n FROM session_outbox").get()).toEqual({ n: 0 });
    expect(parent.steerCalls).toHaveLength(1);
    await node.close("child");
  } finally {
    dispatcherFor(state).stop(); stopInternalNode(state); unregisterPiProvider(provider.provider.id); setNodeDb(); nodeDb.close();
    setDb(new Database(":memory:")); db.close(); rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);

test("session.configuration resolves model, thinking level and task for node-owned sessions only, over the wire", async () => {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON"); setDb(db); runMigrations(db);
  const nodeDb = new Database(":memory:");
  setNodeDb(nodeDb);
  const state = createServerState();
  const node = startNode({ credentials: { read: async () => undefined, list: async () => [], modify: async () => { throw new Error("unexpected"); }, delete: async () => {} } });
  const [serverEnd, nodeEnd] = createLoopbackPair();
  const server = createServerTransport(serverEnd, internalNodeServer(state));
  const connection = connectNode(node, nodeEnd, "test");
  serverEnd.onmessage = server.receive; serverEnd.onclose = server.close;
  nodeEnd.onmessage = connection.receive; nodeEnd.onclose = connection.close;
  try {
    const project = createProject("Config", "/tmp/config");
    const source = internalSource(project.id);
    const owned = { agentRuntimeType: "pi", sourceId: source.id, storageOwner: "internal-node" as const };
    const task = createTask(project.id, "Fix login", "Users can't log in", "task/fix-login");
    setSetting("default_model", { provider: "default-provider", modelId: "default-model", runtimeType: "pi", thinkingLevel: "low" });
    createSession("override", project.id, { ...owned, modelProvider: "p", modelId: "m", thinkingLevel: "high", taskId: task.id });
    createSession("fallback", project.id, owned);
    db.query("UPDATE sessions SET thinking_level = NULL WHERE id = 'fallback'").run();
    createSession("off", project.id, owned);
    createSession("other-runtime", project.id, { ...owned, agentRuntimeType: "claude" });
    db.query("UPDATE sessions SET thinking_level = NULL WHERE id = 'other-runtime'").run();
    createSession("legacy", project.id, { agentRuntimeType: "pi", sourceId: source.id });
    const fetch = (sessionId: string, binding = provisionForSession(sessionId).binding) => connection.configuration({ sessionId, binding });

    expect(await fetch("override")).toEqual({ model: { provider: "p", modelId: "m" }, thinkingLevel: "high",
      task: { title: "Fix login", description: "Users can't log in", branchName: "task/fix-login" } });
    expect(await fetch("fallback")).toEqual({ model: { provider: "default-provider", modelId: "default-model" }, thinkingLevel: "low", task: null });
    // A stored "off" disables thinking even when the default model sets a level.
    expect(await fetch("off")).toEqual({ model: { provider: "default-provider", modelId: "default-model" }, thinkingLevel: null, task: null });
    // The default model applies only to sessions of its runtime type.
    expect(await fetch("other-runtime")).toEqual({ model: null, thinkingLevel: null, task: null });

    const rejected = (promise: Promise<unknown>, message: string) => expect(promise).rejects.toMatchObject({ code: -32000, message });
    await rejected(fetch("override", { ...provisionForSession("override").binding, cwd: "/elsewhere" }), "Node session binding mismatch: override");
    await rejected(fetch("legacy"), "Node session binding mismatch: legacy");
    await rejected(fetch("unknown", provisionForSession("override").binding), "Session not found: unknown");
  } finally { serverEnd.close(); node.stop(); setNodeDb(); nodeDb.close(); setDb(new Database(":memory:")); db.close(); }
});

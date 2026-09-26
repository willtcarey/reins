import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { setDb } from "../../db.js";
import { runMigrations } from "../../migrations.js";
import { createProject } from "../../project-store.js";
import { internalSource } from "../../node-store.js";
import { createSession } from "../../session-store.js";
import { storeSessionAttachment } from "../../session-attachments-store.js";
import { nodeSessionTask, openNodeStorage, setNodeDb } from "@reins/node/storage";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { insertEntry } from "@earendil-works/pi-agent-core/harness/session";
import { createServerState } from "../helpers/server-state.js";
import { internalNodeFor, provisionForSession, stopInternalNode } from "../../runtimes/internal-node.js";
import { createTask, updateTask } from "../../task-store.js";
import { createNewSession } from "../../runtimes/session-manager.js";
import { workForSession } from "../../models/node-command-projection.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { registerPiProvider, unregisterPiProvider } from "../../runtimes/pi/factory.js";
import { setApiKeyCredential } from "../../auth-credentials-store.js";
import { setSetting } from "../../settings-store.js";
import { getSession } from "../../session-store.js";
import { createRuntimeStub } from "../helpers/test-runtime-stub.js";
import { dispatcherFor, NodeCommandDispatcher } from "../../models/node-command-dispatcher.js";

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
      await node.send({ op: "session.provision", sessionId, sourceId: source.id, configuration: { model: null, thinkingLevel: null, task: null } }, provisionForSession(sessionId).binding);
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
    await node.send({ op: "session.provision", sessionId: "legacy", sourceId: source.id, configuration: { model: null, thinkingLevel: null, task: null } }, provisionForSession("legacy").binding);
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
    const provision = () => node.send({ op: "session.provision", sessionId: "owned", sourceId: source.id, configuration: { model: null, thinkingLevel: null, task: null } }, provisionForSession("owned").binding);
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
    await node.send({ op: "session.provision", sessionId: "child", sourceId: source.id,
      configuration: { model: { provider: provider.provider.id, modelId: "fake" }, thinkingLevel: null, task: null } }, binding);
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

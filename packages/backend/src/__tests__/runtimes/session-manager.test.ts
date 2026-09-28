import { nodeRuntimesForTesting } from "@reins/node/node";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Database } from "bun:sqlite";
import { executeSessionCommand } from "../../runtimes/node-execution.js";
import { openNodeDb } from "@reins/node/storage";
import { join } from "node:path";
import { describe, test, expect, spyOn } from "bun:test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { getDb } from "../../db.js";
import { setApiKeyCredential } from "../../auth-credentials-store.js";
import { createProject } from "../../project-store.js";
import { createSession, getSession } from "../session-fixture.js";
import { loadMessages } from "../../messages-store.js";
import { storeSessionAttachment } from "../../session-attachments-store.js";
import { closeTestNodeDb, setTestNodeDb, useTestDb } from "../helpers/test-db.js";
import { createServerState } from "../helpers/server-state.js";
import { useTestRepo } from "../helpers/test-repo.js";
import { createNewSession, SessionManager } from "../../runtimes/session-manager.js";
import { install } from "../../handler.js";
import { enqueueInput, getCommand } from "../../node-command-store.js";
import { replicaInput } from "../../node-replica.js";
import { Sessions } from "../../models/sessions.js";
import { ProjectModel } from "../../models/projects.js";
import { createPiModelRuntime } from "../../runtimes/pi/factory.js";
import { registerPiProvider, unregisterPiProvider } from "../helpers/pi-providers.js";
import { sessionBinding } from "../../runtimes/node-source.js";
import { connectLoopbackNode, drainCommands, loopbackNodeFor, stopLoopbackNode } from "../helpers/loopback-node.js";
import type { ServerState } from "../../state.js";
import { useFakeNode } from "../helpers/fake-node.js";

/** Installs the handler as the process owner does (its hub replaces the state's and starts delivery) and
 * connects the loopback node to it, as the node process would dial in; returns the uninstall. */
function installWithNode(state: ServerState): () => void {
  const { uninstall } = install(state);
  connectLoopbackNode(state);
  return uninstall;
}

function createCapturingWsClient() {
  const sent: any[] = [];
  return {
    client: {
      ws: {
        send(payload: string) {
          sent.push(JSON.parse(payload));
          return payload.length;
        },
      },
    },
    sent,
  };
}

describe("runtime sessions manager", () => {
  useTestDb();
  const repo = useTestRepo();

  test("child completion reports through native steering regardless of parent activity", async () => {
    const state = createServerState();
    const node = useFakeNode(state);
    const project = createProject("Reports", repo.dir);
    createSession("parent", project.id, { agentRuntimeType: "pi", placementStatus: "provisioned" });
    createSession("child", project.id, { agentRuntimeType: "pi", parentSessionId: "parent", placementStatus: "provisioned" });
    const steers = () => node.sent.flatMap((command) => command.op === "session.steer" && command.sessionId === "parent" ? [command] : []);
    const child = new SessionManager(state).forSession("child");
    child.settledWith({ runId: "run-1", status: "completed" }, { reply: { text: "First result", stopReason: "stop", errorMessage: null } }, () => true);
    for (let i = 0; i < 100 && steers().length < 1; i++) await Bun.sleep(5);
    expect(node.sent.some((command) => command.op === "session.prompt")).toBe(false);
    expect(steers()).toHaveLength(1);
    expect(JSON.stringify(steers())).toContain("First result");
    child.settledWith({ runId: "run-2", status: "completed" }, { reply: { text: "Follow-up result", stopReason: "stop", errorMessage: null } }, () => true);
    for (let i = 0; i < 100 && steers().length < 2; i++) await Bun.sleep(5);
    expect(steers()).toHaveLength(2);
    expect(JSON.stringify(steers()[1])).toContain("Follow-up result");
  });

  test("automatic child settlement moves a parent at rest onto its node and retains its source in canonical parent history", async () => {
    const nodeDb = openNodeDb(":memory:");
    setTestNodeDb(nodeDb);
    const state = createServerState(undefined, { loopbackNode: true });
    const project = createProject("Canonical reports", repo.dir);
    const provider = fauxProvider({
      models: [{ id: "settlement-report-model", contextWindow: 200_000, maxTokens: 100 }],
    });
    const parentResponded = Promise.withResolvers<void>();
    provider.setResponses([() => {
      parentResponded.resolve();
      return fauxAssistantMessage("Report received");
    }]);
    registerPiProvider(provider.provider);
    setApiKeyCredential(provider.provider.id, "test-key");
    createSession("parent", project.id, {
      agentRuntimeType: "pi",
      modelProvider: provider.provider.id,
      modelId: "settlement-report-model",
    });
    createSession("child", project.id, { agentRuntimeType: "pi", parentSessionId: "parent", placementStatus: "provisioned" });

    try {
      new SessionManager(state).forSession("child")
        .settledWith({ runId: "settled-run", status: "completed" }, { reply: { text: "Canonical result", stopReason: "stop", errorMessage: null } }, () => true);
      await parentResponded.promise;
      // The parent was at rest on the server: it was hydrated onto the node, whose Pi lane was seeded
      // from the row's model, and the report was admitted there and replicated back.
      expect(getSession("parent")?.placement_status).toBe("provisioned");
      const stored = () => getDb().query<{ message_json: string }, [string]>(
        "SELECT message_json FROM session_messages WHERE session_id = ? AND role = 'reinsInput'",
      ).get("parent");
      for (let i = 0; i < 200 && !stored(); i++) await Bun.sleep(5);
      expect(JSON.parse(stored()!.message_json).message).toMatchObject({
        role: "reinsInput",
        content: [{ type: "text", text: "Canonical result" }],
        metadata: { sourceSessionId: "child" },
      });
      expect(new Sessions(state.nodes).getMessagePage("parent", 10)?.items[0]?.message).toMatchObject({
        role: "user",
        content: [{ type: "text", text: "Canonical result" }],
        metadata: { sourceSessionId: "child" },
      });
    } finally {
      await stopLoopbackNode(state);
      unregisterPiProvider(provider.provider.id);
      setTestNodeDb();
      nodeDb.close();
    }
  }, 15_000);

  test("new internal session prompts in the node database, replicates history, and reopens after node restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reins-node-spike-"));
    const file = join(dir, "node.db");
    closeTestNodeDb();
    const node = openNodeDb(file);
    setTestNodeDb(node);
    const provider = fauxProvider({ provider: "node-spike-faux", models: [{ id: "fake", contextWindow: 200_000, maxTokens: 1_000 }, { id: "other", contextWindow: 200_000, maxTokens: 1_000 }] });
    provider.setResponses([fauxAssistantMessage("Node reply"), fauxAssistantMessage("After restart reply")]);
    registerPiProvider(provider.provider);
    setApiKeyCredential(provider.provider.id, "test-key");
    expect((await createPiModelRuntime()).getModel("node-spike-faux", "fake")).toBeDefined();
    const state = createServerState();
    const client = createCapturingWsClient();
    state.clients.add(client.client);
    const stop = installWithNode(state);
    const project = createProject("Node-backed", repo.dir);
    try {
      const created = createNewSession(state, project.id, {
        model: { provider: provider.provider.id, modelId: "fake" },
      });
      expect(getSession(created.id)?.placement_status).toBe("provisioning");
      for (let i = 0; i < 100 && !node.query("SELECT 1 FROM sessions WHERE id = ?").get(created.id); i++) await Bun.sleep(10);
      expect(node.query("SELECT 1 FROM sessions WHERE id = ?").get(created.id)).not.toBeNull();
      expect(node.query<{ source_id: number; cwd: string; created_at: string }, [string]>(
        "SELECT source_id,cwd,created_at FROM sessions WHERE id = ?",
      ).get(created.id)).toEqual({
        source_id: getSession(created.id)!.source_id,
        cwd: repo.dir,
        created_at: getSession(created.id)!.created_at,
      });
      await executeSessionCommand(state, created.id, "prompt", [{ type: "text", text: "Hello node" }], "node-client");
      // The server waits on its projections (outbox, durable lifecycle reports, replica transcript).
      createSession("caller", project.id, { agentRuntimeType: "pi" });
      expect(await new SessionManager(state).forSession("caller").wait(created.id, 10_000))
        .toEqual({ sessionId: created.id, status: "completed", result: "Node reply", error: null });
      const serverEntries = getDb().query<{ seq: number; harness_id: string; message_json: string }, [string]>(
        "SELECT seq,harness_id,message_json FROM session_messages WHERE session_id = ? ORDER BY seq",
      ).all(created.id);
      const nodeEntries = node.query<{ seq: number; harness_id: string; message_json: string }, [string]>(
        "SELECT seq,harness_id,message_json FROM session_messages WHERE session_id = ? ORDER BY seq",
      ).all(created.id);
      expect(serverEntries).toEqual(nodeEntries);
      for (const table of ["pi_values", "pi_lists", "pi_usage"] as const) {
        const rows = (db: Database) => db.query(`SELECT * FROM ${table} WHERE session_id = ? ORDER BY seq`).all(created.id);
        expect(rows(getDb())).toEqual(rows(node));
      }
      expect(loadMessages(created.id).some(m => JSON.stringify(m).includes("Node reply"))).toBe(true);
      expect(client.sent.some(message => message.type === "event" && message.event.type === "agent_end" && message.sessionId === created.id)).toBe(true);
      expect(getSession(created.id)?.activity_state).toBe("finished");
      // Node-owned: the row changes at once; the node applies the queued session.setModel to Pi's lane.
      await new Sessions(state.nodes).setModel({
        sessionId: created.id, provider: provider.provider.id, modelId: "other",
      });
      expect(getSession(created.id)?.model_id).toBe("other");
      // Delivered commands leave the outbox.
      const modelSet = () => !getDb().query("SELECT 1 FROM node_command_outbox WHERE session_id = ? AND json_extract(command_json, '$.op') = 'session.setModel'").get(created.id);
      for (let i = 0; i < 100 && !modelSet(); i++) await Bun.sleep(10);
      expect((await nodeRuntimesForTesting(loopbackNodeFor(state)).open(created.id, sessionBinding(created.id).binding)).getSessionMetadata()?.model?.modelId).toBe("other");
      await nodeRuntimesForTesting(loopbackNodeFor(state)).close(created.id);
      stop();
      await stopLoopbackNode(state); // the node process restarts with its disk intact
      closeTestNodeDb();
      const reopenedDb = openNodeDb(file);
      setTestNodeDb(reopenedDb);
      const stopRestarted = installWithNode(state);
      try {
        const reopened = await nodeRuntimesForTesting(loopbackNodeFor(state)).open(created.id, sessionBinding(created.id).binding);
        expect(JSON.stringify(await reopened.getMessages())).toContain("Node reply");
        await executeSessionCommand(state, created.id, "steer", [{ type: "text", text: "After restart" }], "after-restart");
        // Admission is proven by the replica: the node committed the input before answering.
        for (let i = 0; i < 100 && getDb().query("SELECT 1 FROM node_command_outbox WHERE session_id = ?").get(created.id); i++) await Bun.sleep(10);
        expect(replicaInput(getDb(), created.id, "after-restart")).not.toBeNull();
        await reopened.waitForIdle();
        expect(JSON.stringify(await reopened.getMessages())).toContain("After restart");
        expect(getDb().query<{ count: number }, [string]>("SELECT COUNT(*) count FROM session_messages WHERE session_id = ?").get(created.id)?.count)
          .toBe(reopenedDb.query<{ count: number }, [string]>("SELECT COUNT(*) count FROM session_messages WHERE session_id = ?").get(created.id)?.count);
        await nodeRuntimesForTesting(loopbackNodeFor(state)).close(created.id);
      } finally { stopRestarted(); }
    } finally {
      stop();
      unregisterPiProvider(provider.provider.id);
      closeTestNodeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  test("lost node storage: the node answers not_found, the server re-hydrates the session from its replica and the prompt runs", async () => {
    const firstDb = openNodeDb(":memory:");
    setTestNodeDb(firstDb);
    const provider = fauxProvider({ provider: "lost-storage-faux", models: [{ id: "fake", contextWindow: 200_000, maxTokens: 1_000 }] });
    provider.setResponses([fauxAssistantMessage("Before the loss"), fauxAssistantMessage("After re-hydration")]);
    registerPiProvider(provider.provider);
    setApiKeyCredential(provider.provider.id, "test-key");
    const state = createServerState(undefined, { loopbackNode: true });
    const settled = (sessionId: string) => getDb().query<{ n: number }, [string]>("SELECT COALESCE(MAX(settlement_count), 0) n FROM node_session_watermarks WHERE session_id = ?").get(sessionId)!.n;
    try {
      const project = createProject("Lost node storage", repo.dir);
      const created = createNewSession(state, project.id, { model: { provider: provider.provider.id, modelId: "fake" } });
      enqueueInput(created.id, "prompt", [{ type: "text", text: "First" }], "first-input");
      await drainCommands(state);
      for (let i = 0; i < 200 && settled(created.id) < 1; i++) await Bun.sleep(5);
      for (let i = 0; i < 200 && firstDb.query("SELECT 1 FROM session_outbox").get(); i++) await Bun.sleep(5);
      const before = getDb().query<{ harness_next_seq: number }, [string]>("SELECT harness_next_seq FROM sessions WHERE id = ?").get(created.id)!.harness_next_seq;
      await stopLoopbackNode(state);
      closeTestNodeDb();
      const replacement = openNodeDb(":memory:");
      setTestNodeDb(replacement);
      connectLoopbackNode(state); // the node restarts on empty storage and dials in again
      const commandId = enqueueInput(created.id, "prompt", [{ type: "text", text: "Can we continue?" }], "lost-input");
      await drainCommands(state);
      expect(getCommand(commandId!)).toBeNull();
      expect(replicaInput(getDb(), created.id, "lost-input")).not.toBeNull();
      expect(getSession(created.id)?.placement_status).toBe("provisioned");
      // The replacement node holds the server's copy again and continues from its sequence.
      expect(replacement.query<{ harness_next_seq: number }, [string]>("SELECT harness_next_seq FROM sessions WHERE id = ?").get(created.id)?.harness_next_seq)
        .toBeGreaterThanOrEqual(before);
      for (let i = 0; i < 200 && settled(created.id) < 2; i++) await Bun.sleep(5);
      for (let i = 0; i < 200 && replacement.query("SELECT 1 FROM session_outbox").get(); i++) await Bun.sleep(5);
      expect(loadMessages(created.id).map(message => [message.role, JSON.stringify(message.content)])).toEqual([
        ["user", JSON.stringify([{ type: "text", text: "First" }])],
        ["assistant", JSON.stringify([{ type: "text", text: "Before the loss" }])],
        ["user", JSON.stringify([{ type: "text", text: "Can we continue?" }])],
        ["assistant", JSON.stringify([{ type: "text", text: "After re-hydration" }])],
      ]);
      expect(getSession(created.id)?.placement_status).toBe("provisioned");
    } finally { await stopLoopbackNode(state); closeTestNodeDb(); unregisterPiProvider(provider.provider.id); }
  }, 15_000);

  test("deleting a task deletes its sessions' node data: at once on a connected node, on reconnection on one that was not", async () => {
    const nodeDb = openNodeDb(":memory:");
    setTestNodeDb(nodeDb);
    const state = createServerState(undefined, { loopbackNode: true });
    const held = (sessionId: string) => !!nodeDb.query("SELECT 1 FROM sessions WHERE id = ?").get(sessionId);
    const pending = () => getDb().query("SELECT session_id, node_id FROM node_session_deletions ORDER BY session_id").all();
    try {
      const project = createProject("Deleted task", repo.dir);
      const tasks = new ProjectModel(project.id, () => {}).tasks();
      const [first, second] = [await tasks.create({ title: "First", description: "" }), await tasks.create({ title: "Second", description: "" })];
      const a = createNewSession(state, project.id, { taskId: first.id });
      const b = createNewSession(state, project.id, { taskId: second.id });
      await drainCommands(state);
      expect([held(a.id), held(b.id)]).toEqual([true, true]);

      await tasks.delete(first.id);
      await state.nodes.wake();
      expect(held(a.id)).toBe(false);
      expect(pending()).toEqual([]);

      // Deleted while the node is away: the deletion waits for it.
      await stopLoopbackNode(state);
      await tasks.delete(second.id);
      await state.nodes.wake();
      expect(pending()).toEqual([{ session_id: b.id, node_id: "internal" }]);
      expect(held(b.id)).toBe(true);
      connectLoopbackNode(state, { db: nodeDb });
      for (let i = 0; i < 200 && pending().length; i++) await Bun.sleep(5);
      expect(pending()).toEqual([]);
      expect(held(b.id)).toBe(false);
    } finally { await stopLoopbackNode(state); closeTestNodeDb(); }
  }, 15_000);

  test("node-owned prompts retain attachment references and hydrate image bytes for Pi", async () => {
    const nodeDb = openNodeDb(":memory:");
    setTestNodeDb(nodeDb);
    const provider = fauxProvider({ provider: "node-image-faux", models: [{ id: "fake", input: ["text", "image"], contextWindow: 200_000, maxTokens: 1_000 }] });
    let providerContext: unknown;
    provider.setResponses([(context) => { providerContext = structuredClone(context.messages); return fauxAssistantMessage("Image received"); }]);
    registerPiProvider(provider.provider);
    setApiKeyCredential(provider.provider.id, "test-key");
    const state = createServerState();
    const client = createCapturingWsClient();
    state.clients.add(client.client);
    const stop = installWithNode(state);
    const warn = spyOn(console, "warn");
    try {
      const project = createProject("Node image", repo.dir);
      const created = createNewSession(state, project.id, { model: { provider: provider.provider.id, modelId: "fake" } });
      const attachment = storeSessionAttachment(created.id, { data: Buffer.from("node image bytes"), mimeType: "image/png", filename: "image.png" });
      await executeSessionCommand(state, created.id, "prompt", [
        { type: "text", text: "Inspect image" },
        { type: "image", attachmentId: attachment.id, mimeType: attachment.mimeType, filename: attachment.filename, byteSize: attachment.byteSize, sha256: attachment.sha256 },
      ], "node-image-client");
      for (let i = 0; i < 100 && !nodeRuntimesForTesting(loopbackNodeFor(state)).has(created.id); i++) await Bun.sleep(10);
      const runtime = await nodeRuntimesForTesting(loopbackNodeFor(state)).open(created.id, sessionBinding(created.id).binding);
      await runtime.waitForIdle();
      expect(JSON.stringify(providerContext)).toContain(Buffer.from("node image bytes").toString("base64"));
      expect(nodeDb.query<{ data: Uint8Array }, [string, string]>(
        "SELECT data FROM node_attachments WHERE session_id = ? AND attachment_id = ?",
      ).get(created.id, attachment.id)?.data).toEqual(Buffer.from("node image bytes"));
      expect(JSON.stringify(loadMessages(created.id))).toContain(attachment.id);
      // The prompt's image is already a reference: its live events reach the browser (none dropped).
      for (let i = 0; i < 100 && !client.sent.some(message => message.event?.type === "agent_end"); i++) await Bun.sleep(5);
      expect(warn.mock.calls.filter(([message]) => String(message).includes("Dropped"))).toEqual([]);
      const promptEvents = client.sent.filter(message => message.type === "event" && message.sessionId === created.id
        && JSON.stringify(message.event).includes(attachment.id)).map(message => message.event.type);
      expect(promptEvents).toEqual(["message_start", "message_end", "entry_added"]);
      await nodeRuntimesForTesting(loopbackNodeFor(state)).close(created.id);
    } finally { warn.mockRestore(); stop(); unregisterPiProvider(provider.provider.id); closeTestNodeDb(); }
  }, 15_000);

  test("createNewSession persists runtime metadata via sessions manager orchestration", async () => {
    const state = createServerState();
    const project = createProject("Reins", repo.dir);

    const managed = await createNewSession(state, project.id, { model: { provider: "anthropic", modelId: "claude-sonnet-4-5" } });
    const row = getSession(managed.id);

    expect(row?.agent_runtime_type).toBe("pi");
    expect(row?.placement_status).toBe("provisioning");
  });

  test("createNewSession persists selected model + thinking level from create settings", async () => {
    const state = createServerState();
    const project = createProject("Reins", repo.dir);

    const managed = await createNewSession(state, project.id, {
      model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
      thinkingLevel: "high",
    });

    const row = getSession(managed.id);
    expect(row?.model_provider).toBe("anthropic");
    expect(row?.model_id).toBe("claude-sonnet-4-5");
    expect(row?.thinking_level).toBe("high");
    expect(row?.agent_runtime_type).toBe("pi");
  });
});

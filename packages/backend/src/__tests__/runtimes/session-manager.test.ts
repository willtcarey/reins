import { nodeRuntimesForTesting } from "@reins/node/node";
import { executeSessionCommand } from "../../runtimes/node-execution.js";
import { describe, test, expect, spyOn } from "bun:test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { getDb } from "../../db.js";
import { setApiKeyCredential } from "../../auth-credentials-store.js";
import { createProject } from "../../project-store.js";
import { createSession, getSession } from "../session-fixture.js";
import { loadMessages } from "../../messages-store.js";
import { storeSessionAttachment } from "../../session-attachments-store.js";
import { useTestDb } from "../helpers/test-db.js";
import { createServerState } from "../helpers/server-state.js";
import { useTestRepo } from "../helpers/test-repo.js";
import { createNewSession, SessionManager } from "../../runtimes/session-manager.js";
import { install } from "../../handler.js";
import { replicaInput } from "../../node-replica.js";
import { Sessions } from "../../models/sessions.js";
import { ProjectModel } from "../../models/projects.js";
import { createPiModelRuntime } from "../../runtimes/pi/factory.js";
import { registerPiProvider, unregisterPiProvider } from "../helpers/pi-providers.js";
import { sessionTarget } from "../../runtimes/node-source.js";
import { connectLoopbackNode, drainCommands, loopbackNodeFor, stopLoopbackNode } from "../helpers/loopback-node.js";
import type { ServerState } from "../../state.js";
import { useFakeNode } from "../helpers/fake-node.js";

/** What the session's opening commands carry, for opening its runtime through the node's test seam. */
const commandTarget = (sessionId: string) => { const { nodeId: _nodeId, ...target } = sessionTarget(sessionId); return target; };

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

  test("automatic child settlement steers the parent on its node and retains its source in canonical parent history", async () => {
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
    createSession("child", project.id, { agentRuntimeType: "pi", parentSessionId: "parent" });

    try {
      new SessionManager(state).forSession("child")
        .settledWith({ runId: "settled-run", status: "completed" }, { reply: { text: "Canonical result", stopReason: "stop", errorMessage: null } }, () => true);
      await parentResponded.promise;
      // The parent's Pi lane was seeded from its row's model; the report was admitted on the node and
      // committed to the server's storage.
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
      const settled = () => getDb().query("SELECT 1 FROM node_session_watermarks WHERE session_id = 'parent' AND settlement_count > 0").get();
      for (let i = 0; i < 200 && !settled(); i++) await Bun.sleep(5);
    } finally {
      await stopLoopbackNode(state);
      unregisterPiProvider(provider.provider.id);
    }
  }, 15_000);

  test("a new session runs on its node over the server's storage, and a restarted node reopens it from the server", async () => {
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
      await executeSessionCommand(state, created.id, "prompt", [{ type: "text", text: "Hello node" }], "node-client");
      // The server waits on its projections (outbox, durable lifecycle reports, its own transcript).
      createSession("caller", project.id, { agentRuntimeType: "pi" });
      expect(await new SessionManager(state).forSession("caller").wait(created.id, 10_000))
        .toEqual({ sessionId: created.id, status: "completed", result: "Node reply", error: null });
      expect(loadMessages(created.id).some(m => JSON.stringify(m).includes("Node reply"))).toBe(true);
      expect(client.sent.some(message => message.type === "event" && message.event.type === "agent_end" && message.sessionId === created.id)).toBe(true);
      expect(getSession(created.id)?.activity_state).toBe("finished");
      // The row changes at once; the node applies the queued session.setModel to Pi's lane.
      await new Sessions(state.nodes).setModel({
        sessionId: created.id, provider: provider.provider.id, modelId: "other",
      });
      expect(getSession(created.id)?.model_id).toBe("other");
      // Delivered commands leave the outbox.
      const modelSet = () => !getDb().query("SELECT 1 FROM node_command_outbox WHERE session_id = ? AND json_extract(command_json, '$.op') = 'session.setModel'").get(created.id);
      for (let i = 0; i < 100 && !modelSet(); i++) await Bun.sleep(10);
      expect((await nodeRuntimesForTesting(loopbackNodeFor(state)).open(created.id, commandTarget(created.id))).getSessionMetadata()?.model?.modelId).toBe("other");
      await nodeRuntimesForTesting(loopbackNodeFor(state)).close(created.id);
      stop();
      await stopLoopbackNode(state); // the node process restarts: it holds nothing of the session
      const stopRestarted = installWithNode(state);
      try {
        const reopened = await nodeRuntimesForTesting(loopbackNodeFor(state)).open(created.id, commandTarget(created.id));
        expect(JSON.stringify(await reopened.getMessages())).toContain("Node reply");
        await executeSessionCommand(state, created.id, "steer", [{ type: "text", text: "After restart" }], "after-restart");
        // Admission is proven by the server's storage: the node committed the input before answering.
        for (let i = 0; i < 100 && getDb().query("SELECT 1 FROM node_command_outbox WHERE session_id = ?").get(created.id); i++) await Bun.sleep(10);
        expect(replicaInput(getDb(), created.id, "after-restart")).not.toBeNull();
        await reopened.waitForIdle();
        expect(JSON.stringify(loadMessages(created.id))).toContain("After restart reply");
        await nodeRuntimesForTesting(loopbackNodeFor(state)).close(created.id);
      } finally { stopRestarted(); }
    } finally {
      stop();
      await stopLoopbackNode(state);
      unregisterPiProvider(provider.provider.id);
    }
  }, 15_000);

  test("deleting a task closes its sessions' runtimes on their node: at once on a connected node, on reconnection on one that was not", async () => {
    const provider = fauxProvider({ provider: "deleted-task-faux", models: [{ id: "fake", contextWindow: 200_000, maxTokens: 1_000 }] });
    registerPiProvider(provider.provider);
    const state = createServerState(undefined, { loopbackNode: true });
    const open = (sessionId: string) => nodeRuntimesForTesting(loopbackNodeFor(state)).open(sessionId, commandTarget(sessionId));
    const held = (sessionId: string) => nodeRuntimesForTesting(loopbackNodeFor(state)).has(sessionId);
    const pending = () => getDb().query("SELECT session_id, node_id FROM node_session_deletions ORDER BY session_id").all();
    try {
      const project = createProject("Deleted task", repo.dir);
      const tasks = new ProjectModel(project.id, () => {}).tasks();
      const [first, second] = [await tasks.create({ title: "First", description: "" }), await tasks.create({ title: "Second", description: "" })];
      const model = { provider: provider.provider.id, modelId: "fake" };
      const a = createNewSession(state, project.id, { taskId: first.id, model });
      const b = createNewSession(state, project.id, { taskId: second.id, model });
      await drainCommands(state);
      await open(a.id);
      expect(held(a.id)).toBe(true);

      await tasks.delete(first.id);
      await state.nodes.wake();
      expect(held(a.id)).toBe(false);
      expect(pending()).toEqual([]);

      // Deleted while the node is away: the deletion waits for it.
      await stopLoopbackNode(state);
      await tasks.delete(second.id);
      await state.nodes.wake();
      expect(pending()).toEqual([{ session_id: b.id, node_id: "internal" }]);
      connectLoopbackNode(state);
      for (let i = 0; i < 200 && pending().length; i++) await Bun.sleep(5);
      expect(pending()).toEqual([]);
    } finally { await stopLoopbackNode(state); unregisterPiProvider(provider.provider.id); }
  }, 15_000);

  test("prompts retain attachment references and hydrate image bytes for Pi on the node", async () => {
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
      const runtime = await nodeRuntimesForTesting(loopbackNodeFor(state)).open(created.id, commandTarget(created.id));
      await runtime.waitForIdle();
      expect(JSON.stringify(providerContext)).toContain(Buffer.from("node image bytes").toString("base64"));
      expect(JSON.stringify(loadMessages(created.id))).toContain(attachment.id);
      // The prompt's image is already a reference: its live events reach the browser (none dropped).
      for (let i = 0; i < 100 && !client.sent.some(message => message.event?.type === "agent_end"); i++) await Bun.sleep(5);
      expect(warn.mock.calls.filter(([message]) => String(message).includes("Dropped"))).toEqual([]);
      const promptEvents = client.sent.filter(message => message.type === "event" && message.sessionId === created.id
        && JSON.stringify(message.event).includes(attachment.id)).map(message => message.event.type);
      expect(promptEvents).toEqual(["message_start", "message_end", "entry_added"]);
      await nodeRuntimesForTesting(loopbackNodeFor(state)).close(created.id);
    } finally { warn.mockRestore(); stop(); await stopLoopbackNode(state); unregisterPiProvider(provider.provider.id); }
  }, 15_000);

  test("createNewSession persists the runtime, selected model and thinking level, and queues nothing", () => {
    const state = createServerState();
    const project = createProject("Reins", repo.dir);

    const managed = createNewSession(state, project.id, {
      model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
      thinkingLevel: "high",
    });

    expect(getSession(managed.id)).toMatchObject({ agent_runtime_type: "pi", model_provider: "anthropic", model_id: "claude-sonnet-4-5", thinking_level: "high" });
    expect(getDb().query("SELECT COUNT(*) AS n FROM node_command_outbox").get()).toEqual({ n: 0 });
  });
});

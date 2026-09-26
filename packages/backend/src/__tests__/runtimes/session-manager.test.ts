import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { executeSessionCommand, wakeSessionInput } from "../../runtimes/node-execution.js";
import { closeNodeDb, setNodeDb, initializeNodeStorage } from "@reins/node/storage";
import { join } from "node:path";
import { describe, test, expect, mock } from "bun:test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { getDb } from "../../db.js";
import { setApiKeyCredential } from "../../auth-credentials-store.js";
import { createProject } from "../../project-store.js";
import { createSession, getSession, updateSessionMetadata } from "../session-fixture.js";
import { loadMessages } from "../../messages-store.js";
import { storeSessionAttachment } from "../../session-attachments-store.js";
import { createTask } from "../../task-store.js";
import { useTestDb } from "../helpers/test-db.js";
import { createServerState } from "../helpers/server-state.js";
import { useTestRepo } from "../helpers/test-repo.js";
import {
  createNewSession,
  ensureSessionOpen,
  SessionManager,
} from "../../runtimes/session-manager.js";
import {
  clearRuntimeAdapters,
  registerRuntimeAdapter,
  ModelNotFoundError,
  type AgentRuntimeAdapter,
  type RuntimeLifecycleSink,
} from "../../runtimes/registry.js";
import { setSetting } from "../../settings-store.js";
import type { WsClient } from "../../state.js";
import { createRuntimeStub } from "../helpers/test-runtime-stub.js";
import { persistCanonicalMessages } from "../helpers/canonical-messages.js";
import { install } from "../../handler.js";
import { NodeCommandDispatcher } from "../../models/node-command-dispatcher.js";
import { enqueueInput, getCommand } from "../../node-command-store.js";
import { observeSubmission } from "../../models/node-command-notifications.js";
import { Sessions } from "../../models/sessions.js";
import { registerPiProvider, unregisterPiProvider, createPiModelRuntime, createPiContext } from "../../runtimes/pi/factory.js";
import { internalNodeFor, provisionForSession, stopInternalNode } from "../../runtimes/internal-node.js";

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

  test("child completion reports through native steering regardless of parent activity, not on open", async () => {
    const state = createServerState();
    const project = createProject("Reports", repo.dir);
    createSession("parent", project.id, { agentRuntimeType: "pi" });
    createSession("child", project.id, { agentRuntimeType: "report-test", parentSessionId: "parent" });
    const parent = createRuntimeStub();
    const firstSteered = Promise.withResolvers<void>();
    const secondSteered = Promise.withResolvers<void>();
    const steer = parent.runtime.steer.bind(parent.runtime);
    parent.runtime.steer = async (content) => {
      await steer(content);
      if (parent.steerCalls.length === 1) firstSteered.resolve();
      if (parent.steerCalls.length === 2) secondSteered.resolve();
    };
    parent.runtime.isStreaming = () => { throw new Error("activity must not choose report delivery"); };
    state.sessions.set("parent", { id: "parent", runtime: parent.runtime, lastActivity: Date.now() });
    const messages = [{ role: "assistant", content: [{ type: "text" as const, text: "First result" }], timestamp: 1 }];
    const child = createRuntimeStub({ messages });
    let lifecycle: RuntimeLifecycleSink | undefined;
    registerRuntimeAdapter({
      runtimeType: "report-test",
      listModels: async () => [],
      ask: async () => "",
      createRuntime: async (params) => {
        lifecycle = params.lifecycle;
        return child.runtime;
      },
    });
    await ensureSessionOpen(state, "child");
    expect(parent.steerCalls).toEqual([]);
    lifecycle!.settled(child.runtime, { runId: "run-1", status: "completed" });
    await firstSteered.promise;
    expect(parent.promptCalls).toEqual([]);
    expect(parent.steerCalls).toHaveLength(1);
    expect(JSON.stringify(parent.steerCalls)).toContain("First result");
    messages.push({ role: "assistant", content: [{ type: "text", text: "Follow-up result" }], timestamp: 2 });
    lifecycle!.settled(child.runtime, { runId: "run-2", status: "completed" });
    await secondSteered.promise;
    expect(parent.steerCalls).toHaveLength(2);
    expect(JSON.stringify(parent.steerCalls)).toContain("Follow-up result");
  });

  test("automatic child settlement retains its source in canonical parent history after reopening", async () => {
    const state = createServerState();
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

    const child = createRuntimeStub({
      messages: [{ role: "assistant", content: [{ type: "text", text: "Canonical result" }], timestamp: 1 }],
    });
    let lifecycle: RuntimeLifecycleSink | undefined;
    registerRuntimeAdapter({
      runtimeType: "settlement-child-test",
      listModels: async () => [],
      ask: async () => "",
      createRuntime: async (params) => {
        lifecycle = params.lifecycle;
        return child.runtime;
      },
    });
    createSession("parent", project.id, {
      agentRuntimeType: "pi",
      modelProvider: provider.provider.id,
      modelId: "settlement-report-model",
    });
    createSession("child", project.id, {
      agentRuntimeType: "settlement-child-test",
      parentSessionId: "parent",
    });

    try {
      await ensureSessionOpen(state, "child");
      expect(state.sessions.has("parent")).toBe(false);

      lifecycle!.settled(child.runtime, { runId: "settled-run", status: "completed" });
      await parentResponded.promise;
      const parent = state.sessions.get("parent");
      if (!parent) throw new Error("Expected the settlement report to reopen the parent");
      await parent.runtime.waitForIdle();

      const stored = getDb().query<{ message_json: string }, [string]>(
        "SELECT message_json FROM session_messages WHERE session_id = ? AND role = 'reinsInput'",
      ).get("parent");
      expect(JSON.parse(stored!.message_json).message).toMatchObject({
        role: "reinsInput",
        content: [{ type: "text", text: "Canonical result" }],
        metadata: { sourceSessionId: "child" },
      });
      expect(new Sessions(state.sessions).getMessagePage("parent", 10)?.items[0]?.message).toMatchObject({
        role: "user",
        content: [{ type: "text", text: "Canonical result" }],
        metadata: { sourceSessionId: "child" },
      });
    } finally {
      await state.sessions.get("parent")?.runtime.close();
      await state.sessions.get("child")?.runtime.close();
      unregisterPiProvider(provider.provider.id);
    }
  }, 15_000);

  test("new internal session prompts in the node database, replicates history, and reopens after node restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reins-node-spike-"));
    const file = join(dir, "node.db");
    closeNodeDb();
    const node = new Database(file);
    initializeNodeStorage(node);
    setNodeDb(node);
    const provider = fauxProvider({ provider: "node-spike-faux", models: [{ id: "fake", contextWindow: 200_000, maxTokens: 1_000 }, { id: "other", contextWindow: 200_000, maxTokens: 1_000 }] });
    provider.setResponses([fauxAssistantMessage("Node reply"), fauxAssistantMessage("After restart reply")]);
    registerPiProvider(provider.provider);
    setApiKeyCredential(provider.provider.id, "test-key");
    expect((await createPiModelRuntime()).getModel("node-spike-faux", "fake")).toBeDefined();
    const state = createServerState();
    const client = createCapturingWsClient();
    state.clients.add(client.client);
    const stop = install(state);
    const project = createProject("Node-backed", repo.dir);
    expect((await createPiContext({ cwd: repo.dir })).modelRuntime.getModel("node-spike-faux", "fake")).toBeDefined();
    try {
      const created = createNewSession(state, project.id, repo.dir, {
        model: { provider: provider.provider.id, modelId: "fake" },
      });
      expect(getSession(created.id)?.storage_owner).toBe("internal-node");
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
      for (let i = 0; i < 100 && !internalNodeFor(state).hasRuntime(created.id); i++) await Bun.sleep(10);
      expect(state.sessions.has(created.id)).toBe(false);
      expect(internalNodeFor(state).hasRuntime(created.id)).toBe(true);
      await expect(new SessionManager(state).open(created.id)).rejects.toThrow("Node-owned sessions open on the node");
      await internalNodeFor(state).open(created.id, provisionForSession(created.id).binding).then(runtime => runtime.waitForIdle());
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
      await new Sessions(state.sessions, undefined, id => internalNodeFor(state).runtime(id), () => wakeSessionInput(state)).setModel({
        sessionId: created.id, provider: provider.provider.id, modelId: "other",
      });
      expect(getSession(created.id)?.model_id).toBe("other");
      const modelSet = () => getDb().query("SELECT 1 FROM node_command_outbox WHERE session_id = ? AND json_extract(command_json, '$.op') = 'session.setModel' AND state = 'admitted'").get(created.id);
      for (let i = 0; i < 100 && !modelSet(); i++) await Bun.sleep(10);
      expect((await internalNodeFor(state).open(created.id, provisionForSession(created.id).binding)).getSessionMetadata()?.model?.modelId).toBe("other");
      await internalNodeFor(state).close(created.id);
      stop();
      closeNodeDb();
      const reopenedDb = new Database(file);
      initializeNodeStorage(reopenedDb);
      setNodeDb(reopenedDb);
      const stopRestarted = install(state);
      try {
        const reopened = await internalNodeFor(state).open(created.id, provisionForSession(created.id).binding);
        expect(state.sessions.has(created.id)).toBe(false);
        expect(JSON.stringify(await reopened.getMessages())).toContain("Node reply");
        await executeSessionCommand(state, created.id, "steer", [{ type: "text", text: "After restart" }], "after-restart");
        for (let i = 0; i < 100 && !getDb().query("SELECT 1 FROM node_command_outbox WHERE session_id = ? AND command_json LIKE '%after-restart%' AND state = 'admitted'").get(created.id); i++) await Bun.sleep(10);
        expect(getDb().query("SELECT 1 FROM node_command_outbox WHERE session_id = ? AND command_json LIKE '%after-restart%' AND state = 'admitted'").get(created.id)).not.toBeNull();
        await reopened.waitForIdle();
        expect(JSON.stringify(await reopened.getMessages())).toContain("After restart");
        expect(getDb().query<{ count: number }, [string]>("SELECT COUNT(*) count FROM session_messages WHERE session_id = ?").get(created.id)?.count)
          .toBe(reopenedDb.query<{ count: number }, [string]>("SELECT COUNT(*) count FROM session_messages WHERE session_id = ?").get(created.id)?.count);
        await internalNodeFor(state).close(created.id);
      } finally { stopRestarted(); }
    } finally {
      stop();
      unregisterPiProvider(provider.provider.id);
      closeNodeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  test("lost node storage rejects a resumed prompt and notifies its submitting client", async () => {
    const firstDb = new Database(":memory:");
    initializeNodeStorage(firstDb);
    setNodeDb(firstDb);
    const state = createServerState();
    const dispatcher = new NodeCommandDispatcher(state);
    try {
      const project = createProject("Lost node storage", repo.dir);
      const created = createNewSession(state, project.id, repo.dir);
      await dispatcher.drain();
      expect(getSession(created.id)?.storage_owner).toBe("internal-node");
      expect(firstDb.query("SELECT id FROM sessions WHERE id = ?").get(created.id)).toEqual({ id: created.id });
      stopInternalNode(state);
      closeNodeDb();
      const replacement = new Database(":memory:");
      initializeNodeStorage(replacement);
      setNodeDb(replacement);
      const client = createCapturingWsClient();
      state.clients.add(client.client);
      observeSubmission(state, created.id, "lost-input", client.client);
      const commandId = enqueueInput(created.id, "prompt", [{ type: "text", text: "Can we continue?" }], "lost-input");
      await dispatcher.drain();
      expect(getCommand(commandId)).toBeNull();
      expect(client.sent).toContainEqual({ type: "error", sessionId: created.id, clientId: "lost-input",
        error: "prompt failed: This session's node data is missing. Start a new session." });
      expect(replacement.query("SELECT id FROM sessions WHERE id = ?").get(created.id)).toBeNull();
    } finally { stopInternalNode(state); closeNodeDb(); }
  });

  test("node-owned prompts retain attachment references and hydrate image bytes for Pi", async () => {
    const nodeDb = new Database(":memory:");
    initializeNodeStorage(nodeDb);
    setNodeDb(nodeDb);
    const provider = fauxProvider({ provider: "node-image-faux", models: [{ id: "fake", input: ["text", "image"], contextWindow: 200_000, maxTokens: 1_000 }] });
    let providerContext: unknown;
    provider.setResponses([(context) => { providerContext = structuredClone(context.messages); return fauxAssistantMessage("Image received"); }]);
    registerPiProvider(provider.provider);
    setApiKeyCredential(provider.provider.id, "test-key");
    const state = createServerState();
    const stop = install(state);
    try {
      const project = createProject("Node image", repo.dir);
      const created = createNewSession(state, project.id, repo.dir, { model: { provider: provider.provider.id, modelId: "fake" } });
      const attachment = storeSessionAttachment(created.id, { data: Buffer.from("node image bytes"), mimeType: "image/png", filename: "image.png" });
      await executeSessionCommand(state, created.id, "prompt", [
        { type: "text", text: "Inspect image" },
        { type: "image", attachmentId: attachment.id, mimeType: attachment.mimeType, filename: attachment.filename, byteSize: attachment.byteSize, sha256: attachment.sha256 },
      ], "node-image-client");
      for (let i = 0; i < 100 && !internalNodeFor(state).hasRuntime(created.id); i++) await Bun.sleep(10);
      const runtime = await internalNodeFor(state).open(created.id, provisionForSession(created.id).binding);
      await runtime.waitForIdle();
      expect(state.sessions.has(created.id)).toBe(false);
      expect(JSON.stringify(providerContext)).toContain(Buffer.from("node image bytes").toString("base64"));
      expect(nodeDb.query<{ data: Uint8Array }, [string, string]>(
        "SELECT data FROM node_attachments WHERE session_id = ? AND attachment_id = ?",
      ).get(created.id, attachment.id)?.data).toEqual(Buffer.from("node image bytes"));
      expect(JSON.stringify(loadMessages(created.id))).toContain(attachment.id);
      await internalNodeFor(state).close(created.id);
    } finally { stop(); unregisterPiProvider(provider.provider.id); closeNodeDb(); }
  }, 15_000);

  test("createNewSession persists runtime metadata via sessions manager orchestration", async () => {
    const state = createServerState();
    const project = createProject("Reins", repo.dir);

    const managed = await createNewSession(state, project.id, repo.dir, { model: { provider: "anthropic", modelId: "claude-sonnet-4-5" } });
    const row = getSession(managed.id);

    expect(row?.agent_runtime_type).toBe("pi");
    expect(managed.scheduling.state).toBe("queued");
    expect(state.sessions.get(managed.id)).toBeUndefined();
  });

  test("createNewSession persists selected model + thinking level from create settings", async () => {
    clearRuntimeAdapters();

    const runtime = {
      ...createRuntimeStub().runtime,
      prompt: async () => ({ messageId: "test-message" }),
      steer: async () => {},
      abort: async () => {},
      setModel: async () => {},
      subscribe: () => () => {},
      getMessages: async () => [],
      isStreaming: () => false,
      close: async () => {},
    };

    registerRuntimeAdapter({
      runtimeType: "pi",
      listModels: async () => [],
      ask: async () => "",
      createRuntime: async () => runtime,
    });

    const state = createServerState();
    const project = createProject("Reins", repo.dir);

    const managed = await createNewSession(state, project.id, repo.dir, {
      model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
      thinkingLevel: "high",
    });

    const row = getSession(managed.id);
    expect(row?.model_provider).toBe("anthropic");
    expect(row?.model_id).toBe("claude-sonnet-4-5");
    expect(row?.thinking_level).toBe("high");
    expect(row?.agent_runtime_type).toBe("pi");

    clearRuntimeAdapters();
  });

  test("managed runtime expands slash-skill prompts before provider runtime", async () => {
    clearRuntimeAdapters();

    const skillDir = join(repo.dir, ".agents", "skills", "fixture-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: fixture-skill\ndescription: fixture skill\n---\n\nFixture skill body.",
      "utf-8",
    );

    let capturedPrompt: unknown;
    registerRuntimeAdapter({
      runtimeType: "test_runtime",
      listModels: async () => [],
      ask: async () => "",
      createRuntime: async () => ({
        prompt: async (content) => {
          capturedPrompt = content;
          return { messageId: "test-message" };
        },
        waitForIdle: async () => {},
        steer: async () => {},
        abort: async () => {},
        setModel: async () => {},
        subscribe: () => () => {},
        getMessages: async () => [],
        isStreaming: () => false,
        close: async () => {},
      }),
    });

    const state = createServerState();
    const project = createProject("Reins", repo.dir);
    createSession("sess-expand-runtime", project.id, { agentRuntimeType: "test_runtime" });

    const managed = await ensureSessionOpen(state, "sess-expand-runtime");
    await managed.runtime.prompt([{ type: "text", text: "/fixture-skill please" }]);

    if (!Array.isArray(capturedPrompt) || capturedPrompt[0]?.type !== "text" || typeof capturedPrompt[0].text !== "string") {
      throw new Error("Expected expanded text prompt");
    }
    expect(capturedPrompt[0].text).toContain("Fixture skill body.");
    expect(capturedPrompt[0].text.endsWith("/fixture-skill please")).toBe(true);
  });

  test("ensureSessionOpen opens node-owned sessions without registering a server runtime", async () => {
    const state = createServerState();
    const project = createProject("Reins", repo.dir);

    const managed = await createNewSession(state, project.id, repo.dir, { model: { provider: "anthropic", modelId: "claude-sonnet-4-5" } });
    updateSessionMetadata(managed.id, { archived: true });
    const archivedAt = getSession(managed.id)!.archived_at;
    state.sessions.delete(managed.id);

    await new NodeCommandDispatcher(state).drain();
    const reopened = await ensureSessionOpen(state, managed.id);

    expect(reopened.id).toBe(managed.id);
    expect(state.sessions.has(managed.id)).toBe(false);
    expect(internalNodeFor(state).hasRuntime(managed.id)).toBe(true);
    expect(getSession(managed.id)!.archived_at).toBe(archivedAt);
    await internalNodeFor(state).close(managed.id);
  });

  test("ensureSessionOpen returns warm in-memory session and touches activity", async () => {
    const now = Date.now() - 1000;
    const managed = {
      id: "sess-live",
      lastActivity: now,
      runtime: {
        ...createRuntimeStub().runtime,
        prompt: async () => ({ messageId: "test-message" }),
        steer: async () => {},
        abort: async () => {},
        setModel: async () => {},
        subscribe: () => () => {},
        getMessages: async () => [],
        isStreaming: () => false,
        close: async () => {},
      },
    };

    const state = createServerState({ sessions: new Map([[managed.id, managed]]) });

    const opened = await ensureSessionOpen(state, managed.id);

    expect(opened).toBe(managed);
    expect(opened.lastActivity).toBeGreaterThan(now);
  });

  test("ensureSessionOpen creates runtime via registry adapter params", async () => {
    clearRuntimeAdapters();

    const createRuntime = mock<AgentRuntimeAdapter["createRuntime"]>(async () => ({
        ...createRuntimeStub().runtime,
        prompt: async () => ({ messageId: "test-message" }),
        steer: async () => {},
        abort: async () => {},
        setModel: async () => {},
        subscribe: () => () => {},
        getMessages: async () => [],
        isStreaming: () => false,
        close: async () => {},
    }));

    registerRuntimeAdapter({
      runtimeType: "test_runtime",
      listModels: async () => [],
      ask: async () => "",
      createRuntime,
    });

    const state = createServerState();
    const project = createProject("Reins", repo.dir);
    createSession("sess-runtime-create", project.id, { agentRuntimeType: "test_runtime" });

    const managed = await ensureSessionOpen(state, "sess-runtime-create");

    expect(createRuntime).toHaveBeenCalledTimes(1);
    const createRuntimeParams = createRuntime.mock.calls[0]?.[0];
    expect(createRuntimeParams).toMatchObject({
      projectId: project.id,
      projectDir: repo.dir,
      sessionId: "sess-runtime-create",
      task: null,
      resume: false,
    });
    expect(createRuntimeParams).not.toHaveProperty("mode");
    expect(state.sessions.get("sess-runtime-create")).toBe(managed);
  });

  test("ensureSessionOpen uses resume=true only when the session has persisted messages", async () => {
    clearRuntimeAdapters();

    const createRuntime = mock<AgentRuntimeAdapter["createRuntime"]>(async () => ({
      ...createRuntimeStub().runtime,
      prompt: async () => ({ messageId: "test-message" }),
      steer: async () => {},
      abort: async () => {},
      setModel: async () => {},
      subscribe: () => () => {},
      getMessages: async () => [],
      isStreaming: () => false,
      close: async () => {},
    }));

    const state = createServerState();
    registerRuntimeAdapter({
      runtimeType: "claude_agent_sdk",
      listModels: async () => [],
      ask: async () => "",
      createRuntime,
    });

    const project = createProject("Reins", repo.dir);
    createSession("sess-runtime-resume", project.id, {
      agentRuntimeType: "claude_agent_sdk",
      modelProvider: "claude_agent_sdk",
      modelId: "claude-sonnet-4-5",
    });
    persistCanonicalMessages("sess-runtime-resume", [{ role: "user", content: [{ type: "text", text: "hello" }] }]);

    await ensureSessionOpen(state, "sess-runtime-resume");

    expect(createRuntime).toHaveBeenCalledTimes(1);
    const createRuntimeParams = createRuntime.mock.calls[0]?.[0];
    expect(createRuntimeParams).toMatchObject({
      sessionId: "sess-runtime-resume",
      resume: true,
    });
  });

  test("ensureSessionOpen skips persistence on aborted compaction_end", async () => {
    clearRuntimeAdapters();

    const listeners = new Set<(event: any) => void>();

    registerRuntimeAdapter({
      runtimeType: "test_runtime",
      listModels: async () => [],
      ask: async () => "",
      createRuntime: async () => ({
        prompt: async () => ({ messageId: "test-message" }),
        steer: async () => {},
        abort: async () => {},
        setModel: async () => {},
        subscribe: (candidate) => {
          listeners.add(candidate);
          return () => {
            listeners.delete(candidate);
          };
        },
        waitForIdle: async () => {},
        getMessages: async () => [{ role: "assistant", content: [{ type: "text", text: "should not persist" }] }],
        isStreaming: () => false,
        close: async () => {},
      }),
    });

    const state = createServerState();
    const project = createProject("Reins", repo.dir);
    createSession("sess-aborted-compaction", project.id, { agentRuntimeType: "test_runtime" });

    await ensureSessionOpen(state, "sess-aborted-compaction");

    const emit = (event: any) => {
      for (const listener of listeners) {
        listener(event);
      }
    };

    emit({ type: "compaction_end", aborted: true });
    await Bun.sleep(0);

    expect(loadMessages("sess-aborted-compaction")).toEqual([]);
  });

  test("ensureSessionOpen broadcasts runtime events from observer layer without remapping", async () => {
    clearRuntimeAdapters();

    const listeners = new Set<(event: any) => void>();

    registerRuntimeAdapter({
      runtimeType: "test_runtime",
      listModels: async () => [],
      ask: async () => "",
      createRuntime: async () => ({
        ...createRuntimeStub().runtime,
        prompt: async () => ({ messageId: "test-message" }),
        steer: async () => {},
        abort: async () => {},
        setModel: async () => {},
        subscribe: (candidate) => {
          listeners.add(candidate);
          return () => {
            listeners.delete(candidate);
          };
        },
        getMessages: async () => [],
        isStreaming: () => false,
        close: async () => {},
      }),
    });

    const wsClient = createCapturingWsClient();
    const state = createServerState({ clients: new Set<WsClient>([wsClient.client]) });
    const project = createProject("Reins", repo.dir);
    createSession("sess-broadcast-observer", project.id, { agentRuntimeType: "test_runtime" });

    await ensureSessionOpen(state, "sess-broadcast-observer");

    const emit = (event: any) => {
      for (const listener of listeners) {
        listener(event);
      }
    };

    emit({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }] }, toolResults: [] });
    emit({ type: "compaction_start", reason: "auto" });
    emit({ type: "compaction_end", result: { summary: "done" }, aborted: true, errorMessage: "oops" });

    expect(wsClient.sent).toEqual([
      {
        type: "event",
        sessionId: "sess-broadcast-observer",
        projectId: project.id,
        event: { type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }] }, toolResults: [] },
      },
      {
        type: "event",
        sessionId: "sess-broadcast-observer",
        projectId: project.id,
        event: { type: "compaction_start", reason: "auto" },
      },
      {
        type: "event",
        sessionId: "sess-broadcast-observer",
        projectId: project.id,
        event: {
          type: "compaction_end",
          result: { summary: "done" },
          aborted: true,
          errorMessage: "oops",
        },
      },
    ]);
  });

  test("ensureSessionOpen unsubscribes observer listeners when runtime closes", async () => {
    clearRuntimeAdapters();

    const listeners = new Set<(event: any) => void>();
    let unsubscribeCount = 0;

    registerRuntimeAdapter({
      runtimeType: "test_runtime",
      listModels: async () => [],
      ask: async () => "",
      createRuntime: async () => ({
        prompt: async () => ({ messageId: "test-message" }),
        steer: async () => {},
        abort: async () => {},
        setModel: async () => {},
        subscribe: (candidate) => {
          listeners.add(candidate);
          return () => {
            unsubscribeCount += 1;
            listeners.delete(candidate);
          };
        },

        getMessages: async () => [],
        waitForIdle: async () => {},
        isStreaming: () => false,
        close: async () => {},
      }),
    });

    const state = createServerState();
    const project = createProject("Reins", repo.dir);
    createSession("sess-observer-cleanup", project.id, { agentRuntimeType: "test_runtime" });

    const managed = await ensureSessionOpen(state, "sess-observer-cleanup");
    expect(listeners.size).toBe(1);

    await managed.runtime.close();

    expect(listeners.size).toBe(0);
    expect(unsubscribeCount).toBe(1);
  });

  test("ensureSessionOpen resolves session tools during runtime creation", async () => {
    clearRuntimeAdapters();

    const createRuntime = mock<AgentRuntimeAdapter["createRuntime"]>(async () => ({
        ...createRuntimeStub().runtime,
        prompt: async () => ({ messageId: "test-message" }),
        steer: async () => {},
        abort: async () => {},
        setModel: async () => {},
        subscribe: () => () => {},
        getMessages: async () => [],
        isStreaming: () => false,
        close: async () => {},
    }));

    registerRuntimeAdapter({
      runtimeType: "test_runtime",
      listModels: async () => [],
      ask: async () => "",
      createRuntime,
    });

    const state = createServerState();
    const project = createProject("Reins", repo.dir);

    // Create the branch so checkoutBranch succeeds when opening the session
    await Bun.spawn(["git", "branch", "task/runtime-tools"], { cwd: repo.dir }).exited;

    const task = createTask(project.id, "Runtime tools", null, "task/runtime-tools");
    createSession("sess-tools", project.id, { agentRuntimeType: "test_runtime", taskId: task.id });

    await ensureSessionOpen(state, "sess-tools");

    const createRuntimeParams = createRuntime.mock.calls[0]?.[0];
    const builtins = createRuntimeParams?.sessionTools?.builtins;
    const harnessToolNames = createRuntimeParams?.sessionTools?.harnessTools?.map((tool: { name: string }) => tool.name);

    expect(builtins).toEqual(["read", "write", "edit", "bash"]);
    expect(harnessToolNames).toEqual(["create_task", "search", "execute"]);
  });

  test("ensureSessionOpen exposes scripting tools for scratch sessions", async () => {
    clearRuntimeAdapters();

    const createRuntime = mock<AgentRuntimeAdapter["createRuntime"]>(async () => ({
        ...createRuntimeStub().runtime,
        prompt: async () => ({ messageId: "test-message" }),
        steer: async () => {},
        abort: async () => {},
        setModel: async () => {},
        subscribe: () => () => {},
        getMessages: async () => [],
        isStreaming: () => false,
        close: async () => {},
    }));

    registerRuntimeAdapter({
      runtimeType: "test_runtime",
      listModels: async () => [],
      ask: async () => "",
      createRuntime,
    });

    const state = createServerState();
    const project = createProject("Reins", repo.dir);
    createSession("sess-scratch-tools", project.id, { agentRuntimeType: "test_runtime" });

    await ensureSessionOpen(state, "sess-scratch-tools");

    const createRuntimeParams = createRuntime.mock.calls[0]?.[0];
    const harnessToolNames = createRuntimeParams?.sessionTools?.harnessTools?.map((tool: { name: string }) => tool.name);
    expect(harnessToolNames).toEqual(["create_task", "search", "execute"]);
  });

  test("ensureSessionOpen maps runtime ModelNotFoundError to configured default model guidance", async () => {
    clearRuntimeAdapters();

    registerRuntimeAdapter({
      runtimeType: "test_runtime",
      listModels: async () => [],
      ask: async () => "",
      createRuntime: async () => {
        throw new ModelNotFoundError("anthropic", "does-not-exist");
      },
    });

    const state = createServerState();
    const project = createProject("Reins", repo.dir);
    createSession("sess-missing-default-model", project.id, { agentRuntimeType: "test_runtime" });

    setSetting("default_model", {
      provider: "anthropic",
      modelId: "does-not-exist",
      runtimeType: "test_runtime",
      thinkingLevel: "high",
    });

    await expect(ensureSessionOpen(state, "sess-missing-default-model")).rejects.toThrow(
      /Configured default_model is invalid: anthropic\/does-not-exist/,
    );
  });

  test("ensureSessionOpen maps runtime ModelNotFoundError to generic invalid model guidance", async () => {
    clearRuntimeAdapters();

    registerRuntimeAdapter({
      runtimeType: "test_runtime",
      listModels: async () => [],
      ask: async () => "",
      createRuntime: async () => {
        throw new ModelNotFoundError("anthropic", "does-not-exist");
      },
    });

    const state = createServerState();
    const project = createProject("Reins", repo.dir);
    createSession("sess-missing-persisted-model", project.id, {
      agentRuntimeType: "test_runtime",
      modelProvider: "anthropic",
      modelId: "does-not-exist",
    });

    await expect(ensureSessionOpen(state, "sess-missing-persisted-model")).rejects.toThrow(
      /Selected session model is invalid: anthropic\/does-not-exist/,
    );
  });

  test("ensureSessionOpen throws when session runtime type is unsupported", async () => {
    const state = createServerState();
    const project = createProject("Reins", repo.dir);
    createSession("sess-unsupported", project.id, { agentRuntimeType: "unknown" });

    await expect(ensureSessionOpen(state, "sess-unsupported")).rejects.toThrow(
      "Runtime adapter 'unknown' is not registered",
    );
  });

  test("ensureSessionOpen throws when session does not exist", async () => {
    const state = createServerState();

    await expect(ensureSessionOpen(state, "missing-session")).rejects.toThrow(
      "Session not found: missing-session",
    );
  });
});

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test, expect, mock } from "bun:test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { getDb } from "../../db.js";
import { createProject } from "../../project-store.js";
import { createSession, getSession } from "../../session-store.js";
import { loadMessages } from "../../messages-store.js";
import { createTask } from "../../task-store.js";
import { useTestDb } from "../helpers/test-db.js";
import { createServerState } from "../helpers/server-state.js";
import { useTestRepo } from "../helpers/test-repo.js";
import {
  createNewSession,
  ensureSessionOpen,
} from "../../runtimes/sessions-manager.js";
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
import { Sessions } from "../../models/sessions.js";
import { registerPiProvider, unregisterPiProvider } from "../../runtimes/pi/factory.js";

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

  test("createNewSession persists runtime metadata via sessions manager orchestration", async () => {
    const state = createServerState();
    const project = createProject("Reins", repo.dir);

    const managed = await createNewSession(state, project.id, repo.dir, { model: { provider: "anthropic", modelId: "claude-sonnet-4-5" } });
    const row = getSession(managed.id);

    expect(row?.agent_runtime_type).toBe("pi");
    expect(state.sessions.get(managed.id)).toBe(managed);
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

  test("ensureSessionOpen reopens persisted sessions and registers them in-memory", async () => {
    const state = createServerState();
    const project = createProject("Reins", repo.dir);

    const managed = await createNewSession(state, project.id, repo.dir, { model: { provider: "anthropic", modelId: "claude-sonnet-4-5" } });
    state.sessions.delete(managed.id);

    const reopened = await ensureSessionOpen(state, managed.id);

    expect(reopened.id).toBe(managed.id);
    expect(state.sessions.get(managed.id)).toBe(reopened);
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

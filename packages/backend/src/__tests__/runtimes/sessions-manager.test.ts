import { describe, test, expect, mock } from "bun:test";
import { createProject } from "../../project-store.js";
import { createSession, getSession, loadMessages } from "../../session-store.js";
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
} from "../../runtimes/registry.js";
import { setSetting } from "../../settings-store.js";
import type { WsClient } from "../../state.js";

describe("runtime sessions manager", () => {
  useTestDb();
  const repo = useTestRepo();

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

  test("createNewSession persists runtime metadata via sessions manager orchestration", async () => {
    const state = createServerState();
    const project = createProject("Reins", repo.dir);

    const managed = await createNewSession(state, project.id, repo.dir);
    const row = getSession(managed.id);

    expect(row?.agent_runtime_type).toBe("pi");
    expect(state.sessions.get(managed.id)).toBe(managed);
  });

  test("createNewSession persists selected model + thinking level from create settings", async () => {
    clearRuntimeAdapters();

    const runtime = {
      prompt: async () => {},
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

    clearRuntimeAdapters();
  });

  test("ensureSessionOpen reopens persisted sessions and registers them in-memory", async () => {
    const state = createServerState();
    const project = createProject("Reins", repo.dir);

    const managed = await createNewSession(state, project.id, repo.dir);
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
        prompt: async () => {},
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
        prompt: async () => {},
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
      taskId: null,
    });
    expect(createRuntimeParams).not.toHaveProperty("mode");
    expect(state.sessions.get("sess-runtime-create")).toBe(managed);
  });

  test("ensureSessionOpen persists by observing runtime events", async () => {
    clearRuntimeAdapters();

    const listeners = new Set<(event: any) => void>();
    let messages: any[] = [];

    registerRuntimeAdapter({
      runtimeType: "test_runtime",
      listModels: async () => [],
      ask: async () => "",
      createRuntime: async (params) => {
        expect(params).not.toHaveProperty("persistenceHooks");

        return {
          prompt: async () => {},
          steer: async () => {},
          abort: async () => {},
          setModel: async () => {},
          subscribe: (candidate) => {
            listeners.add(candidate);
            return () => {
              listeners.delete(candidate);
            };
          },
          getMessages: async () => messages,
          getSessionMetadata: () => ({
            model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
            thinkingLevel: "high",
          }),
          isStreaming: () => false,
          close: async () => {},
        };
      },
    });

    const state = createServerState();
    const project = createProject("Reins", repo.dir);
    createSession("sess-checkpoints", project.id, { agentRuntimeType: "test_runtime" });

    await ensureSessionOpen(state, "sess-checkpoints");

    const emit = (event: any) => {
      for (const listener of listeners) {
        listener(event);
      }
    };

    messages = [{ role: "assistant", content: [{ type: "text", text: "turn output" }] }];
    emit({ type: "turn_end" });
    await Bun.sleep(0);

    messages = [
      { role: "assistant", content: [{ type: "text", text: "turn output" }] },
      { role: "assistant", content: [{ type: "text", text: "post compaction" }] },
    ];
    emit({ type: "compaction_end", aborted: false });
    await Bun.sleep(0);

    messages = [
      { role: "assistant", content: [{ type: "text", text: "turn output" }] },
      { role: "assistant", content: [{ type: "text", text: "post compaction" }] },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ];
    emit({ type: "agent_end" });
    await Bun.sleep(0);

    const persisted = loadMessages("sess-checkpoints");
    expect(persisted).toEqual([
      { role: "assistant", content: [{ type: "text", text: "turn output" }] },
      { role: "assistant", content: [{ type: "text", text: "post compaction" }] },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ]);

    const row = getSession("sess-checkpoints");
    expect(row?.model_provider).toBe("anthropic");
    expect(row?.model_id).toBe("claude-sonnet-4-5");
    expect(row?.thinking_level).toBe("high");
  });

  test("ensureSessionOpen skips persistence on aborted compaction_end", async () => {
    clearRuntimeAdapters();

    const listeners = new Set<(event: any) => void>();

    registerRuntimeAdapter({
      runtimeType: "test_runtime",
      listModels: async () => [],
      ask: async () => "",
      createRuntime: async () => ({
        prompt: async () => {},
        steer: async () => {},
        abort: async () => {},
        setModel: async () => {},
        subscribe: (candidate) => {
          listeners.add(candidate);
          return () => {
            listeners.delete(candidate);
          };
        },
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
        prompt: async () => {},
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

    emit({ type: "turn_end", output: "ok" });
    emit({ type: "compaction_start", reason: "auto" });
    emit({ type: "compaction_end", result: { summary: "done" }, aborted: true, errorMessage: "oops" });

    expect(wsClient.sent).toEqual([
      {
        type: "event",
        sessionId: "sess-broadcast-observer",
        projectId: project.id,
        event: { type: "turn_end", output: "ok" },
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

  test("ensureSessionOpen resolves session tools during runtime creation", async () => {
    clearRuntimeAdapters();

    const createRuntime = mock<AgentRuntimeAdapter["createRuntime"]>(async () => ({
        prompt: async () => {},
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
    const task = createTask(project.id, "Runtime tools", null, "task/runtime-tools");
    createSession("sess-tools", project.id, { agentRuntimeType: "test_runtime", taskId: task.id });

    await ensureSessionOpen(state, "sess-tools");

    const createRuntimeParams = createRuntime.mock.calls[0]?.[0];
    const builtins = createRuntimeParams?.sessionTools?.builtins;
    const customToolNames = createRuntimeParams?.sessionTools?.customTools?.map((tool: { name: string }) => tool.name);

    expect(builtins).toEqual(["read", "write", "edit", "bash"]);
    expect(customToolNames).toContain("create_task");
    expect(customToolNames).toContain("delegate");
  });

  test("ensureSessionOpen omits delegate custom tool for scratch sessions", async () => {
    clearRuntimeAdapters();

    const createRuntime = mock<AgentRuntimeAdapter["createRuntime"]>(async () => ({
        prompt: async () => {},
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
    const customToolNames = createRuntimeParams?.sessionTools?.customTools?.map((tool: { name: string }) => tool.name);
    expect(customToolNames).not.toContain("delegate");
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

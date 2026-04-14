import { describe, test, expect, mock } from "bun:test";
import { createServerState } from "../helpers/server-state.js";
import {
  registerRuntimeAdapter,
  getRuntimeAdapter,
  createAgentRuntime,
  clearRuntimeAdapters,
  listAllRuntimeProviders,
  type AgentRuntime,
  type AgentRuntimeAdapter,
} from "../../runtimes/registry.js";

describe("runtime registry", () => {
  test("registers and looks up adapters by runtime type", () => {
    clearRuntimeAdapters();

    const runtime: AgentRuntime = {
      prompt: async () => {},
      steer: async () => {},
      abort: async () => {},
      setModel: async () => {},
      subscribe: () => () => {},
      getMessages: async () => [],
      isStreaming: () => false,
      close: async () => {},
    };

    const createRuntime = mock<AgentRuntimeAdapter["createRuntime"]>(async () => runtime);

    const adapter: AgentRuntimeAdapter = {
      runtimeType: "pi",
      listModels: async () => [],
      ask: async () => "",
      createRuntime,
    };

    registerRuntimeAdapter(adapter);

    expect(getRuntimeAdapter("pi")).toBe(adapter);

    clearRuntimeAdapters();
  });

  test("createAgentRuntime delegates to the registered adapter", async () => {
    clearRuntimeAdapters();

    const runtime: AgentRuntime = {
      prompt: async () => {},
      steer: async () => {},
      abort: async () => {},
      setModel: async () => {},
      subscribe: () => () => {},
      getMessages: async () => [],
      isStreaming: () => false,
      close: async () => {},
    };

    const inputParams = {
      state: createServerState(),
      projectId: 1,
      projectDir: "/tmp/project-a",
      sessionId: "sess-1",
      taskId: null,
    };

    const { taskId: _taskId, ...expectedRuntimeParams } = inputParams;

    const createRuntime = mock<AgentRuntimeAdapter["createRuntime"]>(async (params) => {
      expect(params).toEqual({ ...expectedRuntimeParams, task: null });
      expect(params).not.toHaveProperty("taskId");
      expect(params).not.toHaveProperty("mode");
      return runtime;
    });

    registerRuntimeAdapter({
      runtimeType: "pi",
      listModels: async () => [],
      ask: async () => "",
      createRuntime,
    });

    const created = await createAgentRuntime("pi", inputParams);

    expect(created).toBe(runtime);
    expect(createRuntime).toHaveBeenCalledTimes(1);

    clearRuntimeAdapters();
  });

  test("listAllRuntimeProviders aggregates provider lists across registered runtimes", async () => {
    clearRuntimeAdapters();

    const aListModels = mock<AgentRuntimeAdapter["listModels"]>(async () => {
      return [{
        provider: "anthropic",
        isAvailable: true,
        availabilitySource: "env",
        availabilitySources: ["env"],
        models: [],
      }];
    });

    const bListModels = mock<AgentRuntimeAdapter["listModels"]>(async () => {
      return [{
        provider: "openai",
        isAvailable: false,
        availabilitySource: null,
        availabilitySources: [],
        models: [],
      }];
    });

    registerRuntimeAdapter({
      runtimeType: "runtime-a",
      listModels: aListModels,
      ask: async () => "",
      createRuntime: async () => ({
        prompt: async () => {},
        steer: async () => {},
        abort: async () => {},
        setModel: async () => {},
        subscribe: () => () => {},
        getMessages: async () => [],
        isStreaming: () => false,
        close: async () => {},
      }),
    });

    registerRuntimeAdapter({
      runtimeType: "runtime-b",
      listModels: bListModels,
      ask: async () => "",
      createRuntime: async () => ({
        prompt: async () => {},
        steer: async () => {},
        abort: async () => {},
        setModel: async () => {},
        subscribe: () => () => {},
        getMessages: async () => [],
        isStreaming: () => false,
        close: async () => {},
      }),
    });

    const providers = await listAllRuntimeProviders();

    expect(providers).toEqual([
      {
        runtimeType: "runtime-a",
        provider: "anthropic",
        isAvailable: true,
        availabilitySource: "env",
        availabilitySources: ["env"],
        models: [],
      },
      {
        runtimeType: "runtime-b",
        provider: "openai",
        isAvailable: false,
        availabilitySource: null,
        availabilitySources: [],
        models: [],
      },
    ]);

    expect(aListModels).toHaveBeenCalledTimes(1);
    expect(bListModels).toHaveBeenCalledTimes(1);

    clearRuntimeAdapters();
  });
});

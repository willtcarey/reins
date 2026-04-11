import { describe, test, expect, mock } from "bun:test";
import { createServerState } from "../helpers/server-state.js";
import {
  registerRuntimeAdapter,
  getRuntimeAdapter,
  createAgentRuntime,
  clearRuntimeAdapters,
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
      subscribe: () => () => {},
      getMessages: async () => [],
      isStreaming: () => false,
      close: async () => {},
    };

    const createRuntime = mock<AgentRuntimeAdapter["createRuntime"]>(async () => runtime);

    const adapter: AgentRuntimeAdapter = {
      runtimeType: "pi",
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
      subscribe: () => () => {},
      getMessages: async () => [],
      isStreaming: () => false,
      close: async () => {},
    };

    const runtimeParams = {
      state: createServerState(),
      projectId: 1,
      projectDir: "/tmp/project-a",
      sessionId: "sess-1",
      taskId: null,
    };

    const createRuntime = mock<AgentRuntimeAdapter["createRuntime"]>(async (params) => {
      expect(params).toEqual(runtimeParams);
      expect(params).not.toHaveProperty("mode");
      return runtime;
    });

    registerRuntimeAdapter({
      runtimeType: "pi",
      createRuntime,
    });

    const created = await createAgentRuntime("pi", runtimeParams);

    expect(created).toBe(runtime);
    expect(createRuntime).toHaveBeenCalledTimes(1);

    clearRuntimeAdapters();
  });
});

import { describe, test, expect, mock } from "bun:test";
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
      close: async () => {},
    };

    const createRuntime = mock<AgentRuntimeAdapter["createRuntime"]>(async () => runtime);

    const adapter: AgentRuntimeAdapter = {
      runtimeType: "pi",
      createRuntime,
    };

    registerRuntimeAdapter(adapter);

    expect(getRuntimeAdapter("pi")).toBe(adapter);
  });

  test("createAgentRuntime delegates to the registered adapter", async () => {
    clearRuntimeAdapters();

    const runtime: AgentRuntime = {
      prompt: async () => {},
      steer: async () => {},
      abort: async () => {},
      subscribe: () => () => {},
      getMessages: async () => [],
      close: async () => {},
    };

    const createRuntime = mock<AgentRuntimeAdapter["createRuntime"]>(async (params) => {
      expect(params).toEqual({ session: { id: "session-1" } });
      return runtime;
    });

    registerRuntimeAdapter({
      runtimeType: "pi",
      createRuntime,
    });

    const created = await createAgentRuntime("pi", { session: { id: "session-1" } });

    expect(created).toBe(runtime);
    expect(createRuntime).toHaveBeenCalledTimes(1);
  });
});

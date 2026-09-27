import { describe, test, expect, mock } from "bun:test";
import {
  registerRuntimeAdapter,
  getRuntimeAdapter,
  clearRuntimeAdapters,
  listAllRuntimeProviders,
  type AgentRuntimeAdapter,
} from "../../runtimes/registry.js";

describe("runtime registry", () => {
  test("registers and looks up adapters by runtime type", () => {
    clearRuntimeAdapters();

    const adapter: AgentRuntimeAdapter = {
      runtimeType: "pi",
      listModels: async () => [],
      ask: async () => "",
    };

    registerRuntimeAdapter(adapter);

    expect(getRuntimeAdapter("pi")).toBe(adapter);

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
    });

    registerRuntimeAdapter({
      runtimeType: "runtime-b",
      listModels: bListModels,
      ask: async () => "",
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

import type { AgentRuntimeAdapter, CreateAgentRuntimeParams, RuntimeAskParams } from "../registry.js";
import { buildAgentHarnessPiRuntime } from "./agent-harness-builder.js";
import { buildProviderList } from "./model-catalog.js";
import { askWithPi } from "./utility.js";

/** The sole persisted Pi session runtime. Utility asks remain ephemeral. */
export class AgentHarnessPiRuntimeAdapter implements AgentRuntimeAdapter {
  readonly runtimeType = "pi";
  listModels() {
    return buildProviderList();
  }

  ask(params: RuntimeAskParams): Promise<string> {
    return askWithPi(params);
  }

  createRuntime(params: CreateAgentRuntimeParams) {
    return buildAgentHarnessPiRuntime(params);
  }
}

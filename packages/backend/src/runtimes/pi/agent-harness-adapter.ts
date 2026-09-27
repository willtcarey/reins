import type { AgentRuntimeAdapter, RuntimeAskParams } from "../registry.js";
import { buildProviderList } from "./model-catalog.js";
import { askWithPi } from "./utility.js";

/** Pi as a library on the server: its model catalog and ephemeral utility asks. Sessions run on nodes. */
export class AgentHarnessPiRuntimeAdapter implements AgentRuntimeAdapter {
  readonly runtimeType = "pi";
  listModels() {
    return buildProviderList();
  }

  ask(params: RuntimeAskParams): Promise<string> {
    return askWithPi(params);
  }
}

import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { AgentRuntimeAdapter, AgentRuntimeCreateParams } from "../registry.js";
import { PiAgentRuntime } from "./runtime.js";

export interface CreatePiRuntimeParams {
  session: AgentSession;
}

export class PiRuntimeAdapter implements AgentRuntimeAdapter {
  readonly runtimeType = "pi";

  async createRuntime(params: AgentRuntimeCreateParams["pi"]) {
    const typedParams: CreatePiRuntimeParams = params;
    return new PiAgentRuntime(typedParams.session);
  }
}

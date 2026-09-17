import type { AgentHarnessTool, ExecutionEnv } from "@earendil-works/pi-agent-core";

/** Turn-scoped capabilities shared by native AgentHarness tools. */
export interface ReinsToolContext {
  env: ExecutionEnv;
}

export type ReinsApplicationTool = AgentHarnessTool<ReinsToolContext | undefined>;

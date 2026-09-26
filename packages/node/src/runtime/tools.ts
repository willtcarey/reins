import {
  createReadTool, createWriteTool, createEditTool, createBashTool,
  type AgentHarnessTool, type ExecutionEnv,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";

export type HostBuiltin = "read" | "write" | "edit" | "bash";
export interface HostToolContext { env: ExecutionEnv }

/** Construct native cwd-scoped Pi tools on the execution host, never through server file APIs. */
export function createHostTools(params: {
  cwd: string;
  sessionId: string;
  builtins: HostBuiltin[];
  sessionEnvironment: { provider: string; modelId: string; thinkingLevel: string | null };
}): { tools: AgentHarnessTool<HostToolContext>[]; executionEnv: NodeExecutionEnv } {
  const executionEnv = new NodeExecutionEnv({ cwd: params.cwd });
  const builtins = new Set<string>(params.builtins);
  const all: AgentHarnessTool<HostToolContext>[] = [
    createReadTool<HostToolContext>(),
    createWriteTool<HostToolContext>(),
    createEditTool<HostToolContext>(),
    createBashTool<HostToolContext>({
      prepare: execution => {
        execution.env.PI_SESSION_ID = params.sessionId;
        execution.env.PI_PROVIDER = params.sessionEnvironment.provider;
        execution.env.PI_MODEL = params.sessionEnvironment.modelId;
        if (params.sessionEnvironment.thinkingLevel) execution.env.PI_REASONING_LEVEL = params.sessionEnvironment.thinkingLevel;
        else delete execution.env.PI_REASONING_LEVEL;
      },
    }),
  ];
  return { tools: all.filter(tool => builtins.has(tool.name)), executionEnv };
}

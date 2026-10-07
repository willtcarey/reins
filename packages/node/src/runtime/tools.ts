import {
  createReadTool, createWriteTool, createEditTool, createBashTool,
  type AgentHarnessTool, type ExecutionEnv,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";

export interface HostToolContext { env: ExecutionEnv }

/** Construct Pi's native cwd-scoped tools (read, write, edit, bash) on the execution host, never through server file APIs.
 * Only `read` is safe to run again: Pi reruns a call an interruption cut off when the tool says so, and
 * tells the model "outcome unknown" otherwise. */
export function createHostTools(params: {
  cwd: string;
  sessionId: string;
  sessionEnvironment: { provider: string; modelId: string; thinkingLevel: string | null };
}): { tools: AgentHarnessTool<HostToolContext>[]; executionEnv: NodeExecutionEnv } {
  const executionEnv = new NodeExecutionEnv({ cwd: params.cwd });
  const tools: AgentHarnessTool<HostToolContext>[] = [
    { ...createReadTool<HostToolContext>(), replay: "safe" },
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
  return { tools, executionEnv };
}

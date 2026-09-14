/* eslint-disable typescript-eslint/consistent-type-assertions -- bridges two public vendor tool contracts */
import type { AgentHarnessTool, AgentTool } from "@earendil-works/pi-agent-core";

export function adaptAgentTool(tool: AgentTool): AgentHarnessTool<undefined> {
  return {
    ...tool,
    replay: tool.replay ?? "never",
    execute(toolCallId, params, onUpdate, _toolContext, _invocation, context) {
      return tool.execute(toolCallId, params, context.abortSignal, (partial) => onUpdate(partial));
    },
  } as AgentHarnessTool<undefined>;
}

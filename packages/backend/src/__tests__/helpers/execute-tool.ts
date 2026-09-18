import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/pi-agent-core";
import type { ReinsApplicationTool } from "../../tools/types.js";

/** Invoke a native harness tool at its public execution boundary in unit tests. */
export function executeTool<TTool extends ReinsApplicationTool>(
  tool: TTool,
  toolCallId: string,
  params: Parameters<TTool["execute"]>[1],
  signal?: AbortSignal,
  _onUpdate?: unknown,
) {
  const context = signal ? withAbortSignal(signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT;
  return tool.execute(
    toolCallId,
    params,
    () => undefined,
    undefined,
    {
      invocationId: toolCallId,
      operationId: toolCallId,
      turnId: toolCallId,
      async getMemo() { return undefined; },
      async setMemo() {},
    },
    context,
  );
}

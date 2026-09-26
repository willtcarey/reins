import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/pi-agent-core";
import type { ReinsApplicationTool } from "../../tools/types.js";
import { createCustomTools, type ServerToolScope } from "../../tools/index.js";

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

/** A Reins application tool (node-package definition) over the in-process server calls legacy sessions use. */
export function reinsTool(name: "create_task" | "search" | "execute", scope: Partial<ServerToolScope> = {}): ReinsApplicationTool {
  const tool = createCustomTools({
    projectId: 0, sessionId: "test-session", taskId: null, broadcast: () => {}, sessions: new Map(), ...scope,
  }).find(item => item.name === name);
  if (!tool) throw new Error(`Missing Reins tool: ${name}`);
  return tool;
}

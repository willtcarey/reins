import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/pi-agent-core";
import { createReinsTools } from "@reins/node/reins-tools";
import { serverToolCalls, type ServerToolScope } from "../../tools/index.js";
import { createServerState } from "./server-state.js";
import { defaultSource } from "../../node-store.js";

type ReinsApplicationTool = ReturnType<typeof createReinsTools>[number];

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

/** A Reins application tool (the node package's definition) over the server calls its node reaches over
 * `script.execute`, `script.search` and `project.createTask`, run in-process. Without `nodes`, no node is
 * connected: a call that reaches the project's checkout fails. The session's source defaults to the
 * project's default source. */
export function reinsTool(name: "create_task" | "search" | "execute", scope: Partial<ServerToolScope> = {}): ReinsApplicationTool {
  const projectId = scope.projectId ?? 0;
  const tool = createReinsTools(serverToolCalls({
    projectId, sessionId: "test-session", taskId: null, sourceId: defaultSource(projectId)?.id ?? 0,
    broadcast: () => {}, nodes: createServerState().nodes, ...scope,
  })).find(item => item.name === name);
  if (!tool) throw new Error(`Missing Reins tool: ${name}`);
  return tool;
}

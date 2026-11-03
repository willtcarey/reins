import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/pi-agent-core";
import { createReinsTools } from "../../session-runtime/reins-tools.js";
import { serverToolCalls } from "../../tools/index.js";
import { createAppState, type TestAppState } from "./app-state.js";
import { Models } from "../../models/models.js";
import { callingSession, type ScriptCaller } from "./script-context.js";

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

/** A Reins application tool (a session runtime's definition) over the server's tool calls of the calling
 * session `caller` (`callingSession`: its row made when the test has none, if it names a project), with
 * the models of `state` (its broadcasts reach its clients). Without `state`, no node is connected: a call
 * that reaches the checkout fails. */
export function reinsTool(
  name: "create_task" | "search" | "execute",
  { state = createAppState(), ...caller }: Omit<ScriptCaller, "signal"> & { state?: TestAppState } = {},
): ReinsApplicationTool {
  // Only a test with a project has a database to keep the calling session in.
  const sessionId = caller.projectId === undefined ? caller.sessionId ?? "test-session" : callingSession(caller);
  const models = new Models(state);
  const tool = createReinsTools(serverToolCalls({
    sessionId, models, ...(caller.instance ? { instance: caller.instance } : {}),
  })).find(item => item.name === name);
  if (!tool) throw new Error(`Missing Reins tool: ${name}`);
  return tool;
}

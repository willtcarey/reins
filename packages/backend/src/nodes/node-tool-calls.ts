import type { ServerState } from "../state.js";
import type { ServerHandlers } from "./server-peer.js";
import { SessionInstance } from "../sessions/session-instance.js";
import { Models } from "../models/models.js";
import { serverToolCalls, sessionToolScope } from "../tools/index.js";

export type NodeToolCalls = Pick<ServerHandlers, "scriptExecute" | "scriptSearch" | "createTask">;

/** Server side of the node's Reins tools (`script.execute`, `script.search`, `project.createTask`).
 * The node's handlers (`node-handlers.ts`) have already authorized the session as placed on the calling node; scope comes from its row, and
 * scripts get a server-side SessionInstance for `sessions.*`. */
export function nodeToolCalls(state: ServerState): NodeToolCalls {
  const calls = (sessionId: string) => {
    const models = new Models(state);
    return serverToolCalls({
      ...sessionToolScope(sessionId), sessionId,
      broadcast: models.broadcast, nodes: state.nodes, models, instance: new SessionInstance(state, sessionId),
    });
  };
  return {
    scriptExecute: ({ sessionId, code }, signal) => calls(sessionId).executeScript(code, signal),
    scriptSearch: ({ sessionId, query }) => calls(sessionId).searchScript(query),
    createTask: ({ sessionId, ...input }) => calls(sessionId).createTask(input),
  };
}

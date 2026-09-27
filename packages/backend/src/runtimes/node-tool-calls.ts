import type { ServerState } from "../state.js";
import type { NodeToolCalls } from "./internal-node.js";
import { SessionManager } from "./session-manager.js";
import { serverToolCalls, sessionToolScope } from "../tools/index.js";

/** Server side of the node's Reins tools (`script.execute`, `script.search`, `project.createTask`).
 * `internal-node.ts` has already authorized the session as placed on the calling node; scope comes from its row, and
 * scripts get a server-side SessionInstance for `sessions.*`. */
export function nodeToolCalls(state: ServerState): NodeToolCalls {
  const manager = new SessionManager(state);
  const calls = (sessionId: string) => serverToolCalls({
    ...sessionToolScope(sessionId), sessionId,
    broadcast: manager.broadcast, instance: manager.forSession(sessionId),
  });
  return {
    scriptExecute: ({ sessionId, code }, signal) => calls(sessionId).executeScript(code, signal),
    scriptSearch: ({ sessionId, query }) => calls(sessionId).searchScript(query),
    createTask: ({ sessionId, ...input }) => calls(sessionId).createTask(input),
  };
}

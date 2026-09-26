import type { ServerState } from "../state.js";
import type { SessionExecutionTarget } from "./execution-target.js";
import { internalNodeFor, provisionForSession, provisionInternal } from "./internal-node.js";

/** Node-owned sessions: provision crosses the JSON-RPC link; other commands reach the in-process node,
 * carrying the outbox command ID as the node's admission receipt. The node starts lazily on first send. */
export function internalNodeExecutionTarget(state: ServerState): SessionExecutionTarget {
  return {
    send(command, commandId) {
      const { binding } = provisionForSession(command.sessionId);
      if (command.op !== "session.provision") return internalNodeFor(state).send(command, binding, commandId);
      if (!commandId) throw new Error("Provision requires an outbox command ID");
      return provisionInternal(state, { sessionId: command.sessionId, commandId, binding });
    },
  };
}

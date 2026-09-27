import type { ServerState } from "../state.js";
import type { SessionExecutionTarget } from "./execution-target.js";
import { provisionForSession, sendInternal } from "./internal-node.js";
import type { NodeCommandTimeouts } from "../node-transport/commands.js";

/** Node-owned sessions: every command crosses the JSON-RPC link with the binding resolved from product
 * rows; submitted work carries its outbox command ID as the node's admission receipt. The node starts
 * lazily on first send. */
export function internalNodeExecutionTarget(state: ServerState, timeouts?: NodeCommandTimeouts): SessionExecutionTarget {
  return {
    send(command, commandId) {
      const { binding } = provisionForSession(command.sessionId);
      return sendInternal(state, command, binding, commandId, timeouts);
    },
  };
}

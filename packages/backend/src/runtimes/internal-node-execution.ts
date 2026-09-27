import { deliveryPolicy } from "@reins/node/contract";
import type { ServerState } from "../state.js";
import type { SessionExecutionTarget } from "./execution-target.js";
import { provisionForSession, sendInternal } from "./internal-node.js";
import type { NodeCommandTimeouts } from "../node-transport/commands.js";
import { hydrateForDelivery, hydrateSession } from "./session-relocation.js";

/** Node-owned sessions: every command crosses the JSON-RPC link with the binding resolved from product
 * rows; submitted work carries its outbox command ID (replays converge on node state, not the ID). Moves
 * (`session.hydrate`) go through session relocation. When the node answers `not_found`
 * to submitted work (its data for the session is missing), the session is re-hydrated onto it from the
 * server's replica and the command is sent once more. */
export function internalNodeExecutionTarget(state: ServerState, timeouts?: NodeCommandTimeouts): SessionExecutionTarget {
  return {
    send(command, commandId) {
      if (command.op === "session.hydrate") return hydrateSession(state, command.sessionId, required(commandId, command.op), command.targetSourceId, timeouts);
      const send = () => sendInternal(state, command, provisionForSession(command.sessionId).binding, commandId, timeouts);
      return send().then(async result => {
        if (result.ok || result.error.code !== "not_found" || command.op === "session.provision" || deliveryPolicy(command) !== "submit-work") return result;
        const rehydrated = await hydrateForDelivery(state, command.sessionId, timeouts);
        return rehydrated.ok ? send() : rehydrated;
      });
    },
  };
}

function required(commandId: string | undefined, op: string): string {
  if (!commandId) throw new Error(`${op} requires an outbox command ID`);
  return commandId;
}

import { deliveryPolicy } from "@reins/node/contract";
import type { ServerState } from "../state.js";
import type { SessionExecutionTarget } from "./execution-target.js";
import { provisionForSession, sendInternal } from "./internal-node.js";
import type { NodeCommandTimeouts } from "../node-transport/commands.js";
import { hydrateForDelivery, hydrateSession } from "./session-relocation.js";
import { getSession } from "../session-store.js";

/** Every command crosses the JSON-RPC link to the session's node with the binding resolved from product
 * rows; submitted work carries its outbox command ID (replays converge on node state, not the ID). Moves
 * (`session.hydrate`) go through session relocation. A session at rest on the server has nothing
 * running (abort answers `aborted: false`); other work for it hydrates it onto its node first (normally
 * a move is already queued ahead of the work; this covers work that reaches the node without one, e.g.
 * behind a move interrupted by a restart). When the node answers `not_found` to submitted work (its data
 * for the session is missing), the session is re-hydrated onto it from the server's replica and the
 * command is sent once more. */
export function internalNodeExecutionTarget(state: ServerState, timeouts?: NodeCommandTimeouts): SessionExecutionTarget {
  return {
    async send(command, commandId) {
      if (command.op === "session.hydrate") return hydrateSession(state, command.sessionId, required(commandId, command.op), command.targetSourceId, timeouts);
      if (getSession(command.sessionId)?.placement_status === "server") {
        if (command.op === "session.abort") return { ok: true, value: { kind: "aborted", aborted: false } };
        const hydrated = await hydrateForDelivery(state, command.sessionId, timeouts);
        if (!hydrated.ok) return hydrated;
      }
      const send = () => sendInternal(state, command, provisionForSession(command.sessionId).binding, commandId, timeouts);
      const result = await send();
      if (result.ok || result.error.code !== "not_found" || command.op === "session.provision" || deliveryPolicy(command) !== "submit-work") return result;
      const rehydrated = await hydrateForDelivery(state, command.sessionId, timeouts);
      return rehydrated.ok ? send() : rehydrated;
    },
  };
}

function required(commandId: string | undefined, op: string): string {
  if (!commandId) throw new Error(`${op} requires an outbox command ID`);
  return commandId;
}

import type { NodeResult } from "@reins/node-protocol";
import type { WsClient } from "../state.js";
import type { SubmissionRecipients } from "../node-link/node-hub.js";
import type { CommandHeader } from "../node-link/node-command-store.js";
import { createBroadcast } from "../models/broadcast.js";
import { getSession } from "../session-store.js";
import { logger } from "../logger.js";

/** After a command settled (an admitted command is already deleted): failures are logged and reported,
 * an input's only to the client that submitted it; a model change's to every viewer (nobody in particular
 * submitted it), who also refresh, since the row keeps the requested model until the next settlement
 * reports the runtime's selection. */
export function onCommandDelivered(clients: Set<WsClient>, recipients: SubmissionRecipients, sessionId: string, command: CommandHeader, outcome: { state: "admitted" | "failed"; result: NodeResult }): void {
  const failure = outcome.state === "failed" ? (outcome.result.ok ? "unknown error" : outcome.result.error.message) : null;
  if (command.op === "session.prompt" || command.op === "session.steer") {
    if (failure !== null && command.clientId !== undefined) recipients.notifyFailure(sessionId, command.clientId, `${command.op === "session.prompt" ? "prompt" : "steer"} failed: ${failure}`);
    return;
  }
  if (command.op !== "session.setModel" || failure === null) return;
  const broadcast = createBroadcast(clients);
  const message = `Model change failed: ${failure}`;
  logger.warn(`${message} (${sessionId})`);
  broadcast({ type: "error", sessionId, error: message });
  const session = getSession(sessionId);
  if (session) broadcast({ type: "session_updated", sessionId, projectId: session.project_id });
}

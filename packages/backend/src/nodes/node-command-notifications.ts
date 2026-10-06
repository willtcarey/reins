import type { NodeResult } from "@reins/node-protocol";
import type { WsClient } from "../state.js";
import type { CommandHeader } from "./node-command-store.js";
import { createBroadcast } from "../models/broadcast.js";
import { getSession } from "../session-store.js";
import { logger } from "../logger.js";

const submissionKey = (sessionId: string, clientId: string) => JSON.stringify([sessionId, clientId]);

/** `client` submitted the input `clientId`, so it hears if that input fails. A delivery hint held by the
 * browser connection, not durable state: a client that disconnected is not told. */
export function observeSubmission(client: WsClient, sessionId: string, clientId: string): void {
  (client.submissions ??= new Set()).add(submissionKey(sessionId, clientId));
}

/** After a command settled (an admitted command is already deleted): failures are logged and reported,
 * an input's only to the connected client that submitted it; a model change's to every viewer (nobody in
 * particular submitted it), who also refresh, since the row keeps the requested model until the next
 * settlement reports the runtime's selection. */
export function onCommandDelivered(clients: Set<WsClient>, sessionId: string, command: CommandHeader, outcome: { state: "admitted" | "failed"; result: NodeResult }): void {
  const failure = outcome.state === "failed" ? (outcome.result.ok ? "unknown error" : outcome.result.error.message) : null;
  if (command.op === "session.prompt" || command.op === "session.steer") {
    if (command.clientId === undefined) return;
    const key = submissionKey(sessionId, command.clientId);
    const error = `${command.op === "session.prompt" ? "prompt" : "steer"} failed: ${failure}`;
    for (const client of clients) {
      if (!client.submissions?.delete(key) || failure === null) continue;
      try { client.ws.send(JSON.stringify({ type: "error", sessionId, clientId: command.clientId, error })); } catch { /* disconnected */ }
    }
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

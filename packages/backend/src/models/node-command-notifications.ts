import type { WsClient } from "../state.js";

const key = (sessionId: string, clientId: string) => JSON.stringify([sessionId, clientId]);

/** The browser clients that submitted inputs, so an input's failure reaches its submitter. A delivery
 * hint, not durable state: a failure is notified once, then its command is deleted. */
export class SubmissionRecipients {
  private readonly recipients = new Map<string, WsClient>();
  constructor(private readonly clients: Set<WsClient>) {}

  observe(sessionId: string, clientId: string, client: WsClient): void {
    this.recipients.set(key(sessionId, clientId), client);
  }

  forget(client: WsClient): void {
    for (const [id, target] of this.recipients) if (target === client) this.recipients.delete(id);
  }

  notifyFailure(sessionId: string, clientId: string, error: string): void {
    const client = this.recipients.get(key(sessionId, clientId));
    if (!client || !this.clients.has(client)) return;
    try { client.ws.send(JSON.stringify({ type: "error", sessionId, clientId, error })); } catch { /* disconnected */ }
  }
}

import type { NodeResult } from "@reins/node/contract";
import type { InputRow } from "../node-command-store.js";
import { createBroadcast } from "./broadcast.js";
import { getSession } from "../session-store.js";
import { logger } from "../logger.js";
/** After a command settled (its placement change already committed): broadcasts placement changes and
 * reports failures. The outcome is passed in: an admitted command is already deleted. */
export function onCommandDelivered(clients: Set<WsClient>, recipients: SubmissionRecipients, row: InputRow, outcome: { state: "admitted" | "failed"; result: NodeResult }): void {
  const payload: unknown = JSON.parse(row.command_json);
  if (!payload || typeof payload !== "object" || !("op" in payload)) return;
  if (payload.op === "session.provision") {
    const session = getSession(row.session_id);
    const broadcast = createBroadcast(clients);
    if (outcome.state === "failed") {
      // The session is `provision_failed` with the reason (e.g. a model the node does not know); it is
      // also logged and broadcast here.
      const message = `Session provisioning failed: ${failureMessage(outcome.result)}`;
      logger.warn(`${message} (${row.session_id})`);
      broadcast({ type: "error", sessionId: row.session_id, error: message });
    }
    if (session) broadcast({ type: "session_updated", sessionId: row.session_id, projectId: session.project_id });
  } else if (payload.op === "session.hydrate") {
    // A move changes where the session lives: every viewer refreshes; a failure (the session stays
    // where it was) is also reported to every viewer, as nobody in particular submitted it.
    const session = getSession(row.session_id);
    const broadcast = createBroadcast(clients);
    if (outcome.state === "failed") {
      const message = `Session move failed: ${failureMessage(outcome.result)}`;
      logger.warn(`${message} (${row.session_id})`);
      broadcast({ type: "error", sessionId: row.session_id, error: message });
    }
    if (session) broadcast({ type: "session_updated", sessionId: row.session_id, projectId: session.project_id });
  } else if (payload.op === "session.setModel" && outcome.state === "failed") {
    // No submitting client is registered for a model change: every client viewing the session sees the
    // error, and a refresh shows the row. The row keeps the requested model until the next settlement
    // reports the runtime's actual selection.
    const message = `Model change failed: ${failureMessage(outcome.result)}`;
    logger.warn(`${message} (${row.session_id})`);
    const session = getSession(row.session_id);
    const broadcast = createBroadcast(clients);
    broadcast({ type: "error", sessionId: row.session_id, error: message });
    if (session) broadcast({ type: "session_updated", sessionId: row.session_id, projectId: session.project_id });
  } else if ((payload.op === "session.prompt" || payload.op === "session.steer") && outcome.state === "failed" && "clientId" in payload && typeof payload.clientId === "string") {
    recipients.notifyFailure(row.session_id, payload.clientId, `${payload.op === "session.prompt" ? "prompt" : "steer"} failed: ${failureMessage(outcome.result)}`);
  }
}

function failureMessage(result: NodeResult): string {
  return result.ok ? "unknown error" : result.error.message;
}

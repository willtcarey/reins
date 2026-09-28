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

import type { NodeResult } from "@reins/node-protocol";
import type { CommandHeader } from "../node-command-store.js";
import { createBroadcast } from "./broadcast.js";
import { getSession } from "../session-store.js";
import { logger } from "../logger.js";

/** Failures reported to every viewer of the session, as nobody in particular submitted them (a provision
 * failure leaves it `provision_failed`, a failed move returns it where it was, a failed model change
 * keeps the requested model on the row until the next settlement reports the runtime's selection). */
const viewerFailures: Record<string, string> = {
  "session.provision": "Session provisioning failed",
  "session.hydrate": "Session move failed",
  "session.setModel": "Model change failed",
};

/** After a command settled (its placement change already committed; an admitted command is already
 * deleted): a provision or move changes where the session lives, so every viewer refreshes; failures are
 * logged and broadcast to every viewer, except an input's, which goes to the client that submitted it. */
export function onCommandDelivered(clients: Set<WsClient>, recipients: SubmissionRecipients, sessionId: string, command: CommandHeader, outcome: { state: "admitted" | "failed"; result: NodeResult }): void {
  const failure = outcome.state === "failed" ? (outcome.result.ok ? "unknown error" : outcome.result.error.message) : null;
  if (command.op === "session.prompt" || command.op === "session.steer") {
    if (failure !== null && command.clientId !== undefined) recipients.notifyFailure(sessionId, command.clientId, `${command.op === "session.prompt" ? "prompt" : "steer"} failed: ${failure}`);
    return;
  }
  const label = viewerFailures[command.op];
  if (!label || (command.op === "session.setModel" && failure === null)) return;
  const broadcast = createBroadcast(clients);
  if (failure !== null) {
    const message = `${label}: ${failure}`;
    logger.warn(`${message} (${sessionId})`);
    broadcast({ type: "error", sessionId, error: message });
  }
  const session = getSession(sessionId);
  if (session) broadcast({ type: "session_updated", sessionId, projectId: session.project_id });
}

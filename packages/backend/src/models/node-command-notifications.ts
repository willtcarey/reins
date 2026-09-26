import type { ServerState, WsClient } from "../state.js";

/** A delivery hint, not durable state: the outbox retains the failure after disconnect. */
const recipients = new WeakMap<ServerState, Map<string, WsClient>>();
const key = (sessionId: string, clientId: string) => JSON.stringify([sessionId, clientId]);

export function observeSubmission(state: ServerState, sessionId: string, clientId: string, client: WsClient): void {
  let registered = recipients.get(state);
  if (!registered) { registered = new Map(); recipients.set(state, registered); }
  registered.set(key(sessionId, clientId), client);
}

export function forgetClient(state: ServerState, client: WsClient): void {
  const registered = recipients.get(state);
  if (!registered) return;
  for (const [id, target] of registered) if (target === client) registered.delete(id);
}

export function notifySubmissionFailure(state: ServerState, sessionId: string, clientId: string, error: string): void {
  const client = recipients.get(state)?.get(key(sessionId, clientId));
  if (!client || !state.clients.has(client)) return;
  try { client.ws.send(JSON.stringify({ type: "error", sessionId, clientId, error })); } catch { /* disconnected */ }
}

import { getCommand, type InputRow } from "../node-command-store.js";
import { createBroadcast } from "./broadcast.js";
import { getSession } from "../session-store.js";
export function onCommandDelivered(state: ServerState, row: InputRow): void {
  const outcome = getCommand(row.id);
  if (!outcome || outcome.state === "queued" || outcome.state === "dispatching") return;
  const payload: unknown = JSON.parse(row.command_json);
  if (!payload || typeof payload !== "object" || !("op" in payload)) return;
  if (payload.op === "session.provision") {
    const session = getSession(row.session_id);
    if (session) createBroadcast(state.clients)({ type: "session_updated", sessionId: row.session_id, projectId: session.project_id });
  } else if ((payload.op === "session.prompt" || payload.op === "session.steer") && (outcome.state === "failed" || outcome.state === "unknown") && "clientId" in payload && typeof payload.clientId === "string") {
    const result: unknown = outcome.result_json && JSON.parse(outcome.result_json);
    const error = result && typeof result === "object" && "error" in result ? result.error : null;
    const message = typeof error === "string" ? error : error && typeof error === "object" && "message" in error ? String(error.message) : "unknown error";
    notifySubmissionFailure(state, row.session_id, payload.clientId, `${payload.op === "session.prompt" ? "prompt" : "steer"} failed: ${message}`);
  }
}

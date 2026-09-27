import { getDb } from "./db.js";
import type { ClientPromptContent } from "./messages-store.js";
import { replicaInput } from "./node-replica.js";
import { recoverInterruptedDispatches } from "./node-command-recovery.js";

/**
 * The outbox is a queue: a command is `queued`, then `dispatching` while one delivery is in flight.
 * Settling deletes it: an admitted command in the settling transaction, a failed one (briefly `failed`)
 * right after its failure is notified. `admitted` and `unknown` remain in the table's CHECK constraint
 * only for history; nothing writes them.
 */
export type CommandState = "queued" | "dispatching" | "failed";
export interface CommandRow {
  id: string;
  session_id: string;
  source_id: number;
  state: CommandState;
  command_json: string;
  result_json: string | null;
}

/** The session's provision or move still queued or being delivered, if any. */
export function pendingPlacementCommand(sessionId: string): { id: string; state: "queued" | "dispatching" } | null {
  return getDb().query<{ id: string; state: "queued" | "dispatching" }, [string]>(`SELECT id, state FROM node_command_outbox WHERE session_id = ?
    AND state IN ('queued', 'dispatching') AND json_extract(command_json, '$.op') IN ('session.provision', 'session.hydrate')
    ORDER BY rowid LIMIT 1`).get(sessionId) ?? null;
}

export function getCommand(id: string): CommandRow | null {
  return getDb().query<CommandRow, [string]>(`SELECT o.*, s.source_id FROM node_command_outbox o
    JOIN sessions s ON s.id = o.session_id WHERE o.id = ?`).get(id) ?? null;
}

export function insertCommandWithSession(id: string, sessionId: string, commandJson: string, createSession: () => void): void {
  getDb().transaction(() => {
    createSession();
    getDb().query("INSERT INTO node_command_outbox (id, session_id, command_json, state) VALUES (?, ?, ?, 'queued')")
      .run(id, sessionId, commandJson);
  })();
}

export function queuedCommands(): InputRow[] {
  return getDb().query<InputRow, []>("SELECT id, session_id, command_json, state, result_json FROM node_command_outbox WHERE state = 'queued' ORDER BY rowid").all();
}

/** Only work still being delivered blocks later commands in the session. */
export function hasBlockingPredecessor(id: string): boolean {
  return !!getDb().query<{ id: string }, [string]>(`SELECT earlier.id FROM node_command_outbox current
    JOIN node_command_outbox earlier ON earlier.session_id = current.session_id AND earlier.rowid < current.rowid
    WHERE current.id = ? AND earlier.state IN ('queued', 'dispatching') LIMIT 1`).get(id);
}

/** The claim is the delivery guard: one atomic statement moves a queued command to dispatching only
 * while no earlier command in its session is queued or dispatching, so a session never has two
 * commands in flight, whichever dispatcher (or process) claims. */
export function claimCommand(id: string): boolean {
  return getDb().query(`UPDATE node_command_outbox SET state = 'dispatching' WHERE id = ? AND state = 'queued'
    AND NOT EXISTS (SELECT 1 FROM node_command_outbox earlier WHERE earlier.session_id = node_command_outbox.session_id
      AND earlier.rowid < node_command_outbox.rowid AND earlier.state IN ('queued', 'dispatching'))`).run(id).changes > 0;
}

/** Synchronous, so it commits with the placement change the outcome causes. An admitted command is
 * deleted; a failed one keeps its result until its failure is notified (`deleteFailedCommand`). */
export function settleCommand(id: string, state: "admitted" | "failed", resultJson: string | null = null): void {
  if (state === "admitted") getDb().query("DELETE FROM node_command_outbox WHERE id = ? AND state = 'dispatching'").run(id);
  else getDb().query("UPDATE node_command_outbox SET state = 'failed', result_json = ? WHERE id = ? AND state = 'dispatching'").run(resultJson, id);
}

/** Only for adapters whose replay is idempotent (node commands converge on their own state). */
export function requeueCommand(id: string): void {
  getDb().query("UPDATE node_command_outbox SET state = 'queued' WHERE id = ? AND state = 'dispatching'").run(id);
}

/** Process startup: see `recoverInterruptedDispatches`. */
export function recoverInterruptedCommands(): void {
  recoverInterruptedDispatches(getDb());
}

export function deleteFailedCommand(id: string): void {
  getDb().query("DELETE FROM node_command_outbox WHERE id = ? AND state = 'failed'").run(id);
}


export interface InputRow {
  id: string;
  session_id: string;
  command_json: string;
  state: CommandState;
  result_json: string | null;
}

/** Returns the queued command's ID (a replay of pending input returns the same ID), or null for a replay
 * of input the node already admitted (it is in the replica, and its command was deleted). */
export function enqueueInput(sessionId: string, operation: "prompt" | "steer", content: ClientPromptContent, clientId: string, sourceSessionId?: string): string | null {
  const db = getDb();
  return db.transaction(() => {
    const existing = db.query<InputRow, [string, string]>("SELECT * FROM node_command_outbox WHERE session_id = ? AND json_extract(command_json, '$.clientId') = ?").get(sessionId, clientId);
    const json = JSON.stringify({ op: `session.${operation}`, clientId, content, sourceSessionId: sourceSessionId ?? null });
    if (existing?.command_json !== undefined && existing.command_json !== json) throw new Error("clientId already used for different input");
    if (existing) return existing.id;
    if (replicaInput(db, sessionId, clientId)) return null;
    const id = crypto.randomUUID();
    db.query("INSERT INTO node_command_outbox (id, session_id, command_json, state) VALUES (?, ?, ?, 'queued')").run(id, sessionId, json);
    return id;
  })();
}

/** Queues a model change behind the session's earlier outbox work. Not deduplicated: each request is
 * its own command and the last one delivered wins. Synchronous, so a caller can enqueue inside its own
 * transaction. */
export function enqueueSetModel(sessionId: string, model: { provider: string; modelId: string; thinkingLevel?: string }): string {
  const id = crypto.randomUUID();
  const json = JSON.stringify({ op: "session.setModel", provider: model.provider, modelId: model.modelId,
    ...(model.thinkingLevel === undefined ? {} : { thinkingLevel: model.thinkingLevel }) });
  getDb().query("INSERT INTO node_command_outbox (id, session_id, command_json, state) VALUES (?, ?, ?, 'queued')").run(id, sessionId, json);
  return id;
}

/** Whether input with this client ID is pending in the outbox or was admitted (it is in the replica). */
export function hasInput(sessionId: string, clientId: string): boolean {
  return !!getDb().query("SELECT 1 FROM node_command_outbox WHERE session_id = ? AND json_extract(command_json, '$.clientId') = ?").get(sessionId, clientId)
    || !!replicaInput(getDb(), sessionId, clientId);
}

export function hasPendingInput(sessionId: string): boolean {
  return !!getDb().query<{ id: string }, [string]>("SELECT id FROM node_command_outbox WHERE session_id = ? AND json_extract(command_json, '$.clientId') IS NOT NULL AND state IN ('queued', 'dispatching') LIMIT 1").get(sessionId);
}

/** The session's prompt/steer inputs still queued or being delivered, with their client IDs. */
export function pendingInputs(sessionId: string): Array<{ id: string; clientId: string }> {
  return getDb().query<{ id: string; clientId: string }, [string]>(`SELECT id, json_extract(command_json, '$.clientId') AS clientId FROM node_command_outbox
    WHERE session_id = ? AND json_extract(command_json, '$.clientId') IS NOT NULL AND state IN ('queued', 'dispatching') ORDER BY rowid`).all(sessionId);
}

/** Whether a command is still queued or being delivered (settled commands are deleted). */
export function isCommandPending(id: string): boolean {
  return !!getDb().query("SELECT 1 FROM node_command_outbox WHERE id = ? AND state IN ('queued', 'dispatching')").get(id);
}

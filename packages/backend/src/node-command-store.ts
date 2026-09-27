import { getDb } from "./db.js";
import type { ClientPromptContent } from "./messages-store.js";

export type CommandState = "queued" | "dispatching" | "admitted" | "failed" | "unknown";
export interface CommandRow {
  id: string;
  session_id: string;
  source_id: number;
  state: CommandState;
  command_json: string;
  result_json: string | null;
}

/** The session's open record on its node: its latest provision or hydrate (a session created on a node
 * is provisioned; one moved there from the server is hydrated, possibly again after a release). */
export function getCommandForSession(sessionId: string): { id: string } | null {
  return getDb().query<{ id: string }, [string]>(`SELECT id FROM node_command_outbox WHERE session_id = ?
    AND json_extract(command_json, '$.op') IN ('session.provision', 'session.hydrate') ORDER BY rowid DESC LIMIT 1`).get(sessionId) ?? null;
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

export function settleCommand(id: string, state: "admitted" | "failed", resultJson: string | null = null): void {
  getDb().query("UPDATE node_command_outbox SET state = ?, result_json = ? WHERE id = ? AND state = 'dispatching'").run(state, resultJson, id);
}

/** Only for adapters whose replay is idempotent (node commands converge on their own state). */
export function requeueCommand(id: string): void {
  getDb().query("UPDATE node_command_outbox SET state = 'queued' WHERE id = ? AND state = 'dispatching'").run(id);
}

export function blockInterruptedDispatches(): void {
  getDb().query("UPDATE node_command_outbox SET state = 'unknown' WHERE state = 'dispatching'").run();
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

export function enqueueInput(sessionId: string, operation: "prompt" | "steer", content: ClientPromptContent, clientId: string, sourceSessionId?: string): string {
  const db = getDb();
  return db.transaction(() => {
    const existing = db.query<InputRow, [string, string]>("SELECT * FROM node_command_outbox WHERE session_id = ? AND json_extract(command_json, '$.clientId') = ?").get(sessionId, clientId);
    const json = JSON.stringify({ op: `session.${operation}`, clientId, content, sourceSessionId: sourceSessionId ?? null });
    if (existing?.command_json !== undefined && existing.command_json !== json) throw new Error("clientId already used for different input");
    if (existing) return existing.id;
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

/** Whether input with this client ID was ever stored for the session (and not removed as failed). */
export function hasInput(sessionId: string, clientId: string): boolean {
  return !!getDb().query("SELECT 1 FROM node_command_outbox WHERE session_id = ? AND json_extract(command_json, '$.clientId') = ?").get(sessionId, clientId);
}

export function hasPendingInput(sessionId: string): boolean {
  return !!getDb().query<{ id: string }, [string]>("SELECT id FROM node_command_outbox WHERE session_id = ? AND json_extract(command_json, '$.clientId') IS NOT NULL AND state IN ('queued', 'dispatching') LIMIT 1").get(sessionId);
}

/** IDs of the session's prompt/steer inputs still queued or being delivered. */
export function pendingInputIds(sessionId: string): string[] {
  return getDb().query<{ id: string }, [string]>("SELECT id FROM node_command_outbox WHERE session_id = ? AND json_extract(command_json, '$.clientId') IS NOT NULL AND state IN ('queued', 'dispatching') ORDER BY rowid").all(sessionId).map(row => row.id);
}

/** A command's delivery state; null once a failed command was removed. */
export function commandState(id: string): CommandState | null {
  return getDb().query<{ state: CommandState }, [string]>("SELECT state FROM node_command_outbox WHERE id = ?").get(id)?.state ?? null;
}

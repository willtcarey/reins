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

export function getCommandForSession(sessionId: string): { id: string } | null {
  return getDb().query<{ id: string }, [string]>("SELECT id FROM node_command_outbox WHERE session_id = ? AND json_extract(command_json, '$.op') = 'session.provision' LIMIT 1").get(sessionId) ?? null;
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

export function claimCommand(id: string): boolean {
  return getDb().query("UPDATE node_command_outbox SET state = 'dispatching' WHERE id = ? AND state = 'queued'").run(id).changes > 0;
}

export function settleCommand(id: string, state: "admitted" | "failed", resultJson: string | null = null): void {
  getDb().query("UPDATE node_command_outbox SET state = ?, result_json = ? WHERE id = ? AND state = 'dispatching'").run(state, resultJson, id);
}

/** Only for adapters whose replay is idempotent by command ID (node provision receipts). */
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

export function hasPendingInput(sessionId: string): boolean {
  return !!getDb().query<{ id: string }, [string]>("SELECT id FROM node_command_outbox WHERE session_id = ? AND json_extract(command_json, '$.clientId') IS NOT NULL AND state IN ('queued', 'dispatching') LIMIT 1").get(sessionId);
}

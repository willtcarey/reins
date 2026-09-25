import { getDb } from "./db.js";

export type CommandState = "queued" | "dispatching" | "admitted" | "failed" | "unknown";
export interface CommandRow {
  id: string;
  session_id: string;
  source_id: number;
  state: CommandState;
  command_json: string;
  result_json: string | null;
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

export function queuedCommandIds(): string[] {
  return getDb().query<{ id: string }, []>("SELECT id FROM node_command_outbox WHERE state = 'queued' ORDER BY created_at, id").all().map(row => row.id);
}

export function claimCommand(id: string): boolean {
  return getDb().query("UPDATE node_command_outbox SET state = 'dispatching' WHERE id = ? AND state = 'queued'").run(id).changes > 0;
}

export function settleCommand(id: string, state: "admitted" | "failed" | "unknown", resultJson: string | null = null): void {
  getDb().query("UPDATE node_command_outbox SET state = ?, result_json = ? WHERE id = ? AND state = 'dispatching'").run(state, resultJson, id);
}

export function blockInterruptedDispatches(): void {
  getDb().query("UPDATE node_command_outbox SET state = 'unknown' WHERE state = 'dispatching'").run();
}

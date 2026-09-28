import { nodeCommand, type NodeCommand } from "@reins/node/contract";
import { z } from "zod";
import { getDb } from "./db.js";
import type { ClientPromptContent } from "./messages-store.js";
import { replicaInput } from "./node-replica.js";

/**
 * The outbox is a queue: a command is `queued`, then `dispatching` while one delivery is in flight.
 * Settling deletes it: an admitted command in the settling transaction, a failed one (briefly `failed`)
 * right after its failure is notified. Each session's commands are delivered in rowid order.
 */
export type CommandState = "queued" | "dispatching" | "failed";
export interface CommandRow {
  id: string;
  session_id: string;
  state: CommandState;
  command_json: string;
  result_json: string | null;
}

/** The resting state a failed move returns the session to: at rest on the server, or provisioned on the
 * source it left. Stored with the hydrate command (server-side only: the contract schema strips it). */
export const moveRevert = z.object({ status: z.enum(["server", "provisioned"]), sourceId: z.number().int() });

/**
 * The server's own reading of a stored command, parsed once when it is delivered: its op and the fields
 * the server acts on when it settles (an input's client ID, a move's target and `revertTo`, and
 * `rehydrated`, set on work that was already requeued behind a re-hydration). It does not validate the
 * node payload, so a command that does not parse still settles and notifies like any other.
 */
const storedCommand = z.object({
  op: z.string(),
  clientId: z.string().optional(),
  targetSourceId: z.number().int().optional(),
  revertTo: moveRevert.optional(),
  rehydrated: z.literal(true).optional(),
});
export type CommandHeader = z.infer<typeof storedCommand>;
export function commandHeader(commandJson: string): CommandHeader {
  return storedCommand.parse(JSON.parse(commandJson));
}

/** Inserts a queued command. `ahead`: below every rowid in the outbox, so it is delivered before the
 * session's pending work (a hydrate queued for work that needs the session on its node). */
export function insertCommand(id: string, sessionId: string, commandJson: string, { ahead = false }: { ahead?: boolean } = {}): void {
  if (ahead) {
    getDb().query(`INSERT INTO node_command_outbox (rowid, id, session_id, command_json, state)
      VALUES ((SELECT COALESCE(MIN(rowid), 1) - 1 FROM node_command_outbox), ?, ?, ?, 'queued')`).run(id, sessionId, commandJson);
  } else {
    getDb().query("INSERT INTO node_command_outbox (id, session_id, command_json, state) VALUES (?, ?, ?, 'queued')").run(id, sessionId, commandJson);
  }
}

/** The session's provision or move still queued or being delivered, if any. */
export function pendingPlacementCommand(sessionId: string): { id: string; state: "queued" | "dispatching" } | null {
  return getDb().query<{ id: string; state: "queued" | "dispatching" }, [string]>(`SELECT id, state FROM node_command_outbox WHERE session_id = ?
    AND state IN ('queued', 'dispatching') AND json_extract(command_json, '$.op') IN ('session.provision', 'session.hydrate')
    ORDER BY rowid LIMIT 1`).get(sessionId) ?? null;
}

export function getCommand(id: string): (CommandRow & { source_id: number }) | null {
  return getDb().query<CommandRow & { source_id: number }, [string]>(`SELECT o.*, s.source_id FROM node_command_outbox o
    JOIN sessions s ON s.id = o.session_id WHERE o.id = ?`).get(id) ?? null;
}

/** A command still in the outbox (settled commands are deleted). A session's placement is its
 * `placement_status` column, not its outbox rows. */
export type StoredNodeCommand = { id: string; sessionId: string; command: NodeCommand };

/** The stored command, parsed strictly with the session's current IDs. Every writer stores a
 * `nodeCommand` payload, so one that does not parse is an invalid command: this throws, and its
 * delivery fails like any other. */
export function getNodeCommand(id: string): StoredNodeCommand | null {
  const row = getCommand(id);
  if (!row) return null;
  const command = nodeCommand.safeParse({ ...JSON.parse(row.command_json), sessionId: row.session_id, sourceId: row.source_id });
  if (!command.success) throw new Error(`Stored node command is invalid: ${z.prettifyError(command.error)}`);
  return { id: row.id, sessionId: row.session_id, command: command.data };
}

/** Stores a new session (`createSession` sets `placement_status = 'provisioning'`) and its provision
 * command in one transaction. The session row supplies sessionId/sourceId on read; the stored
 * configuration is the frozen payload every (re)delivery sends, so a replay carries the same configuration. */
export function createSessionWithProvision(id: string, command: NodeCommand, createSession: () => void): void {
  const parsed = nodeCommand.parse(command);
  if (parsed.op !== "session.provision") throw new Error("Only a provision command is stored with a new session");
  const { sessionId, sourceId: _sourceId, ...stored } = parsed;
  getDb().transaction(() => {
    createSession();
    insertCommand(id, sessionId, JSON.stringify(stored));
  })();
}

export function queuedCommands(): CommandRow[] {
  return getDb().query<CommandRow, []>("SELECT id, session_id, command_json, state, result_json FROM node_command_outbox WHERE state = 'queued' ORDER BY rowid").all();
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

/** Marks work requeued behind a re-hydration, so a second `not_found` settles it instead. */
export function markRehydrated(id: string): void {
  getDb().query("UPDATE node_command_outbox SET command_json = json_set(command_json, '$.rehydrated', json('true')) WHERE id = ?").run(id);
}

export function deleteFailedCommand(id: string): void {
  getDb().query("DELETE FROM node_command_outbox WHERE id = ? AND state = 'failed'").run(id);
}


/** Returns the queued command's ID (a replay of pending input returns the same ID), or null for a replay
 * of input the node already admitted (it is in the replica, and its command was deleted). The one place
 * input is deduplicated by client ID: `beforeInsert` runs (in the same transaction) only when the input
 * is new, just before it is queued. */
export function enqueueInput(sessionId: string, operation: "prompt" | "steer", content: ClientPromptContent, clientId: string,
  sourceSessionId?: string, beforeInsert?: () => void): string | null {
  const db = getDb();
  return db.transaction(() => {
    const existing = db.query<CommandRow, [string, string]>("SELECT * FROM node_command_outbox WHERE session_id = ? AND json_extract(command_json, '$.clientId') = ?").get(sessionId, clientId);
    const json = JSON.stringify({ op: `session.${operation}`, clientId, content, sourceSessionId: sourceSessionId ?? null });
    if (existing) {
      const { rehydrated: _rehydrated, ...stored } = JSON.parse(existing.command_json);
      if (JSON.stringify(stored) !== json) throw new Error("clientId already used for different input");
      return existing.id;
    }
    if (replicaInput(db, sessionId, clientId)) return null;
    beforeInsert?.();
    const id = crypto.randomUUID();
    insertCommand(id, sessionId, json);
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
  insertCommand(id, sessionId, json);
  return id;
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

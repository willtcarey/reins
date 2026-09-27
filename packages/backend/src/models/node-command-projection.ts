import { deliveryPolicy, nodeCommand, nodeResult, type NodeCommand, type NodeResult } from "@reins/node/contract";
import { getCommand, insertCommandWithSession, type CommandState } from "../node-command-store.js";

/** A command still in the outbox (settled commands are deleted, so this is pending work, or a failed
 * command about to be notified and removed). `command` is null for a stored command that no longer
 * parses (e.g. a provision stored before it carried its configuration): an unparseable
 * queued/dispatching row reads as failed and is never delivered. A session's placement is its
 * `placement_status` column, not its outbox rows. */
export type Work = { id: string; sessionId: string; sourceId: number; state: CommandState; command: NodeCommand | null; result: NodeResult | null };

export function getWork(id: string): Work | null {
  const row = getCommand(id);
  if (!row) return null;
  const command = nodeCommand.safeParse({ ...JSON.parse(row.command_json), sessionId: row.session_id, sourceId: row.source_id });
  const dispatchable = row.state === "queued" || row.state === "dispatching";
  if (!command.success && dispatchable) return { id: row.id, sessionId: row.session_id, sourceId: row.source_id, state: "failed", command: null,
    result: { ok: false, error: { code: "invalid_request", message: "Stored node command is invalid", retryable: false } } };
  return { id: row.id, sessionId: row.session_id, sourceId: row.source_id, state: row.state, command: command.success ? command.data : null, result: row.result_json ? nodeResult.parse(JSON.parse(row.result_json)) : null };
}

/** Stores the session (its `create` callback sets `placement_status = 'provisioning'`) and its
 * provision command in one transaction. */
export function scheduleWork(id: string, command: NodeCommand, create: () => void): void {
  const parsed = nodeCommand.parse(command);
  if (deliveryPolicy(parsed) !== "submit-work" || parsed.op !== "session.provision") throw new Error("Only provision commands may be scheduled");
  const { sessionId, sourceId: _sourceId, ...stored } = parsed;
  // The session row supplies sessionId/sourceId on read; the stored configuration is the frozen payload
  // every (re)delivery sends, so a replay carries the same configuration.
  insertCommandWithSession(id, sessionId, JSON.stringify(stored), create);
}


import type { ServerState } from "../state.js";
const wakes = new WeakMap<ServerState, () => void>();
export function registerCommandWake(state: ServerState, wake: () => void): void { wakes.set(state, wake); }
export function wakeScheduledCommands(state: ServerState): void { wakes.get(state)?.(); }

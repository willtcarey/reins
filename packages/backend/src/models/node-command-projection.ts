import { deliveryPolicy, nodeCommand, type NodeCommand } from "@reins/node/contract";
import { z } from "zod";
import { getCommand, insertCommandWithSession } from "../node-command-store.js";

/** A command still in the outbox (settled commands are deleted). A session's placement is its
 * `placement_status` column, not its outbox rows. */
export type Work = { id: string; sessionId: string; command: NodeCommand };

/** The stored command, parsed strictly with the session's current IDs. Every writer stores a
 * `nodeCommand` payload, so one that does not parse is an invalid command: this throws, and its
 * delivery fails like any other. */
export function getWork(id: string): Work | null {
  const row = getCommand(id);
  if (!row) return null;
  const command = nodeCommand.safeParse({ ...JSON.parse(row.command_json), sessionId: row.session_id, sourceId: row.source_id });
  if (!command.success) throw new Error(`Stored node command is invalid: ${z.prettifyError(command.error)}`);
  return { id: row.id, sessionId: row.session_id, command: command.data };
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

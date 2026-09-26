import { deliveryPolicy, nodeCommand, nodeResult, type NodeCommand, type NodeResult } from "@reins/node/contract";
import { getCommand, getCommandForSession, insertCommandWithSession, type CommandState } from "../node-command-store.js";

export type Work = { id: string; sessionId: string; sourceId: number; state: CommandState; command: NodeCommand; result: NodeResult | null };

export function workForSession(sessionId: string): Work | null {
  const row = getCommandForSession(sessionId);
  return row ? getWork(row.id) : null;
}

export function getWork(id: string): Work | null {
  const row = getCommand(id);
  if (!row) return null;
  const command = nodeCommand.parse({ ...JSON.parse(row.command_json), sessionId: row.session_id, sourceId: row.source_id });
  return { id: row.id, sessionId: row.session_id, sourceId: row.source_id, state: row.state, command, result: row.result_json && row.state !== "unknown" ? nodeResult.parse(JSON.parse(row.result_json)) : null };
}

export function scheduleWork(id: string, command: NodeCommand, create: () => void): Work {
  if (deliveryPolicy(command) !== "submit-work" || command.op !== "session.provision") throw new Error("Only provision commands may be scheduled");
  nodeCommand.parse(command);
  insertCommandWithSession(id, command.sessionId, JSON.stringify({ op: command.op }), create);
  return getWork(id)!;
}


import type { ServerState } from "../state.js";
const wakes = new WeakMap<ServerState, () => void>();
export function registerCommandWake(state: ServerState, wake: () => void): void { wakes.set(state, wake); }
export function wakeScheduledCommands(state: ServerState): void { wakes.get(state)?.(); }

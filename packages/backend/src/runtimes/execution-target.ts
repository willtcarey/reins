import type { NodeCommand, NodeResult } from "@reins/node/contract";
import type { SessionRow } from "../session-store.js";
import type { ServerState } from "../state.js";

/**
 * Where a session's commands execute. Callers resolve a target from the session's storage owner
 * instead of branching on it; the internal node and legacy server-owned sessions are both targets.
 * Deliberately exposes no live runtime: opening a runtime is not part of command execution.
 */
export interface SessionExecutionTarget {
  /**
   * Delivers one semantic command. `commandId` is the outbox row ID: it is the node's idempotency
   * receipt and is required for `session.provision`. Provision may throw `DeliveryDeferred` when the
   * target may not have received or may have admitted it; the outbox requeues it.
   */
  send(command: NodeCommand, commandId?: string): Promise<NodeResult>;
}

export type StorageOwner = SessionRow["storage_owner"];
export type ExecutionTargets = Record<StorageOwner, SessionExecutionTarget>;

const registered = new WeakMap<ServerState, ExecutionTargets>();

/** Installed by the composition root (`installRuntimeHooks`), so execution callers import no
 * target implementation. Returns an uninstall that only removes this registration. */
export function registerExecutionTargets(state: ServerState, targets: ExecutionTargets): () => void {
  registered.set(state, targets);
  return () => { if (registered.get(state) === targets) registered.delete(state); };
}

/** Selects the session's execution target by storage owner. Source validation stays with callers. */
export function executionTargetFor(state: ServerState, session: Pick<SessionRow, "id" | "storage_owner">): SessionExecutionTarget {
  const targets = registered.get(state);
  if (!targets) throw new Error("Session execution targets unavailable");
  const target = targets[session.storage_owner];
  if (!target) throw new Error(`No execution target for session ${session.id} (${session.storage_owner})`);
  return target;
}

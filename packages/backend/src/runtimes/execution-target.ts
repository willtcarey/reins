import type { NodeCommand, NodeResult } from "@reins/node/contract";
import type { ServerState } from "../state.js";

/**
 * Where a session's commands execute: always its node (the server never runs sessions; one at rest on
 * the server is hydrated onto its node first). Deliberately exposes no live runtime: opening a runtime
 * is not part of command execution.
 */
export interface SessionExecutionTarget {
  /**
   * Delivers one semantic command. `commandId` is the outbox row ID, required for submitted work
   * (provision, prompt, steer, setModel, hydrate; a replay converges on the node's state, not on the ID),
   * which may throw `DeliveryDeferred` when the target may not have received or may have admitted it; the
   * outbox requeues it. Immediate controls (abort, resumePending) carry no ID and are never requeued.
   */
  send(command: NodeCommand, commandId?: string): Promise<NodeResult>;
}

const registered = new WeakMap<ServerState, SessionExecutionTarget>();

/** Installed by the composition root (`installRuntimeHooks`), so execution callers import no target
 * implementation. Returns an uninstall that only removes this registration. */
export function registerExecutionTarget(state: ServerState, target: SessionExecutionTarget): () => void {
  registered.set(state, target);
  return () => { if (registered.get(state) === target) registered.delete(state); };
}

/** The installed execution target. Source validation stays with callers. */
export function executionTargetFor(state: ServerState): SessionExecutionTarget {
  const target = registered.get(state);
  if (!target) throw new Error("Session execution target unavailable");
  return target;
}

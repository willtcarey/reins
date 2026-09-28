import { nodeResult, type NodeResult } from "@reins/node-protocol";
import { claimCommand, getCommand, requeueCommand, settleCommand } from "../node-command-store.js";
import { logger } from "../logger.js";
import { getDb } from "../db.js";

/** Thrown by an adapter whose replay is idempotent (each node command converges on its own state)
 * when the outcome is unknown or delivery never happened: the command returns to the queue. */
export class DeliveryDeferred extends Error {}

/** `claimed: false`: not sent (not queued, or behind earlier work). `queued`: deferred and requeued (tried
 * again on a later wake). `requeued`: back in the queue behind work `commit` queued ahead of it, deliverable
 * now. Otherwise the recorded result: an admitted command is already deleted, a failed one is left for its
 * failure to be notified and then removed. */
export type DeliveryOutcome =
  | { claimed: false }
  | { claimed: true; state: "queued" }
  | { claimed: true; state: "requeued" }
  | { claimed: true; state: "admitted" | "failed"; result: NodeResult };

/** Claim once; other delivery exceptions are terminal failures, never automatically retried. `commit`
 * runs in the settling transaction for every result, success or failure (a session's placement changes
 * there); returning `"requeue"` puts the command back in the queue instead of settling it. */
export async function deliverCommand(id: string, send: () => Promise<NodeResult>, commit: (result: NodeResult) => void | "requeue" = () => {}): Promise<DeliveryOutcome> {
  if (!claimCommand(id)) return { claimed: false };
  let result: NodeResult;
  try {
    result = nodeResult.parse(await send());
  } catch (error) {
    if (error instanceof DeliveryDeferred) {
      logger.warn(`Command dispatch deferred for ${getCommand(id)?.session_id}:`, error.message);
      requeueCommand(id);
      return { claimed: true, state: "queued" };
    }
    logger.error(`Command dispatch failed for ${getCommand(id)?.session_id}:`, error);
    result = { ok: false, error: { code: "internal", message: error instanceof Error ? error.message : String(error), retryable: false } };
  }
  const requeued = getDb().transaction(() => {
    if (commit(result) === "requeue") { requeueCommand(id); return true; }
    settleCommand(id, result.ok ? "admitted" : "failed", JSON.stringify(result));
    return false;
  })();
  return requeued ? { claimed: true, state: "requeued" } : { claimed: true, state: result.ok ? "admitted" : "failed", result };
}

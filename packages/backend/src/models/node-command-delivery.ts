import { DeliveryDeferred, nodeResult, type NodeResult } from "@reins/node-protocol";
import { claimCommand, getCommand, requeueCommand, settleCommand } from "../node-command-store.js";
import { logger } from "../logger.js";

/** `claimed: false`: not sent (not queued, or behind earlier work). `queued`: deferred and requeued (tried
 * again on a later wake). Otherwise the recorded result: an admitted command is already deleted, a failed
 * one is left for its failure to be notified and then removed. */
export type DeliveryOutcome =
  | { claimed: false }
  | { claimed: true; state: "queued" }
  | { claimed: true; state: "admitted" | "failed"; result: NodeResult };

/** Claim once; other delivery exceptions are terminal failures, never automatically retried. */
export async function deliverCommand(id: string, send: () => Promise<NodeResult>): Promise<DeliveryOutcome> {
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
  settleCommand(id, result.ok ? "admitted" : "failed", JSON.stringify(result));
  return { claimed: true, state: result.ok ? "admitted" : "failed", result };
}

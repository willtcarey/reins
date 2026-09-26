import { nodeResult, type NodeResult } from "@reins/node/contract";
import { claimCommand, getCommand, requeueCommand, settleCommand } from "../node-command-store.js";
import { logger } from "../logger.js";

/** Thrown by an adapter whose replay is idempotent (a durable node receipt keyed by command ID)
 * when the outcome is unknown or delivery never happened: the command returns to the queue. */
export class DeliveryDeferred extends Error {}

/** Claim once; other delivery exceptions are terminal failures, never automatically retried. */
export async function deliverCommand(id: string, send: () => Promise<NodeResult>): Promise<void> {
  if (!claimCommand(id)) return;
  try {
    const result = nodeResult.parse(await send());
    settleCommand(id, result.ok ? "admitted" : "failed", JSON.stringify(result));
  } catch (error) {
    if (error instanceof DeliveryDeferred) {
      logger.warn(`Command dispatch deferred for ${getCommand(id)?.session_id}:`, error.message);
      requeueCommand(id);
      return;
    }
    logger.error(`Command dispatch failed for ${getCommand(id)?.session_id}:`, error);
    settleCommand(id, "failed", JSON.stringify({ ok: false, error: {
      code: "internal", message: error instanceof Error ? error.message : String(error), retryable: false,
    } }));
  }
}

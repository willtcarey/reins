import { nodeResult, type NodeResult } from "@reins/node/contract";
import { claimCommand, getCommand, settleCommand } from "../node-command-store.js";
import { logger } from "../logger.js";

/** Claim once; exceptions and lost acknowledgements have unknown outcomes, never retries. */
export async function deliverCommand(id: string, send: () => Promise<NodeResult>): Promise<void> {
  if (!claimCommand(id)) return;
  try {
    const result = nodeResult.parse(await send());
    settleCommand(id, result.ok ? "admitted" : "failed", JSON.stringify(result));
  } catch (error) {
    logger.error(`Command dispatch outcome unknown for ${getCommand(id)?.session_id}:`, error);
    settleCommand(id, "unknown", JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
}

import {
  BACKGROUND_CONTEXT,
  branchTip,
  type Entry,
} from "@earendil-works/pi-agent-core";
import { getDb } from "./db.js";
import { PiStorageAdapter } from "@reins/pi-sql-storage";

/** Load the canonical main branch through AgentHarness's storage contract. */
export async function loadActivePiEntries(sessionId: string): Promise<Entry[]> {
  const storage = new PiStorageAdapter(getDb(), sessionId);
  const tip = await storage.getValue(branchTip("main"), BACKGROUND_CONTEXT);
  if (!tip || tip.value === null) return [];

  return storage.scanBranch({ start: tip.value, order: "oldestFirst" }, BACKGROUND_CONTEXT);
}

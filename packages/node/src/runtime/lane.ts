import type { Storage } from "@earendil-works/pi-agent-core";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import type { NodeSessionBinding } from "@reins/node-protocol";
import { createMainLane as createPiMainLane, storedLaneModel as piStoredLaneModel } from "@reins/pi-sql-storage/lane";

/** Has Pi create the session's main lane through the node's `storage` (so the lane is an ordinary Pi
 * commit, replicated like any other), seeded from the provision's binding and configuration. */
export async function createMainLane(storage: Storage, sessionId: string, binding: NodeSessionBinding, models: Models, model: Model<Api>, thinkingLevel: string | null): Promise<void> {
  await createPiMainLane(storage, {
    sessionId, createdAt: binding.createdAt, cwd: binding.cwd, parentSessionId: binding.parentSessionId, models, model, thinkingLevel,
  });
}

/** Provisioning (`node.ts`) reads the stored lane model through here; see `@reins/pi-sql-storage/lane`. */
export function storedLaneModel(storage: Storage): ReturnType<typeof piStoredLaneModel> {
  return piStoredLaneModel(storage);
}

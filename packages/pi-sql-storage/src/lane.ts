/**
 * The session's main Pi lane: Reins drives a single lane per session, created with the session's model
 * and thinking level before its first run. Shared by the node (creating it when a session is provisioned)
 * and the server (creating it in its own database).
 */
import { AgentHarness, BACKGROUND_CONTEXT, laneConfig, StorageBackedSession, type Storage, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model, Models } from "@earendil-works/pi-ai";

/** Reins drives a single Pi lane per session. */
export const MAIN_LANE = "main";

const thinkingLevels: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Contract thinking levels are strings (null: off); Pi's lane stores its own enum. */
export function piThinkingLevel(value: string | null | undefined): ThinkingLevel {
  if (value == null) return "off";
  const level = thinkingLevels.find(candidate => candidate === value);
  if (!level) throw new Error(`Invalid thinking level: ${value}`);
  return level;
}

/**
 * The model selection stored in the session's main lane, or null when Pi has not created it. Read
 * through Pi's own lane address because it is needed before a harness can be built (building one
 * requires a registry model, and an unknown stored model must still be reported by name).
 */
export async function storedLaneModel(storage: Storage): Promise<{ provider: string; modelId: string; thinkingLevel: ThinkingLevel } | null> {
  const stored = await storage.getValue(laneConfig(MAIN_LANE), BACKGROUND_CONTEXT);
  return stored ? { ...stored.value.model, thinkingLevel: stored.value.thinkingLevel } : null;
}

/** What Pi needs to create a session's main lane. `createdAt` is ISO 8601; `thinkingLevel` is a
 * contract level (null: off). */
export interface MainLaneSeed {
  sessionId: string;
  createdAt: string;
  cwd: string;
  parentSessionId: string | null;
  models: Models;
  model: Model<Api>;
  thinkingLevel: string | null;
}

/**
 * Has Pi create the session's main lane, seeded with `seed.model` and `seed.thinkingLevel`, through
 * `storage` (so the lane is an ordinary Pi commit). Only Pi's seed is needed: no tools (the runtime
 * registers its tools when it first opens), prompt or resources. Pi attaches an existing lane without
 * writing, so a repeat is harmless. Closes the harness and with it `storage`.
 */
export async function createMainLane(storage: Storage, seed: MainLaneSeed): Promise<void> {
  const session = new StorageBackedSession({
    id: seed.sessionId, createdAt: Date.parse(seed.createdAt), storageVersion: 1, cwd: seed.cwd,
    ...(seed.parentSessionId ? { parentSessionId: seed.parentSessionId } : {}),
  }, storage);
  let harness;
  try {
    ({ harness } = await AgentHarness.create({ session, models: seed.models, model: seed.model, thinkingLevel: piThinkingLevel(seed.thinkingLevel), activeToolNames: [] }, BACKGROUND_CONTEXT));
  } catch (error) {
    await session.close(BACKGROUND_CONTEXT).catch(() => undefined);
    throw error;
  }
  try { await harness.lane(MAIN_LANE, BACKGROUND_CONTEXT); }
  finally { await harness.close(BACKGROUND_CONTEXT); }
}

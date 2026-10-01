/**
 * The session's main Pi lane: Reins drives a single lane per session, which Pi creates, seeded with the
 * session's model and thinking level, when the node first opens the session's runtime.
 */
import { BACKGROUND_CONTEXT, laneConfig, type Storage, type ThinkingLevel } from "@earendil-works/pi-agent-core";

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

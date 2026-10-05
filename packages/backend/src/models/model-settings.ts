import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";
import { getSetting, type ModelSettingsKey, type ModelSetting } from "../settings-store.js";

export const THINKING_LEVEL_VALUES = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

export const ThinkingLevelSchema = Type.Union(
  THINKING_LEVEL_VALUES.map((level) => Type.Literal(level)),
  { description: `Thinking level (${THINKING_LEVEL_VALUES.join(", ")})` },
);

export type ThinkingLevel = Static<typeof ThinkingLevelSchema>;

export function isThinkingLevel(value: string): value is ThinkingLevel {
  return THINKING_LEVEL_VALUES.some((candidate) => candidate === value);
}

export function parseThinkingLevel(value: string): ThinkingLevel {
  if (isThinkingLevel(value)) return value;

  throw new Error(
    `Invalid thinking level '${value}'. Valid levels: ${THINKING_LEVEL_VALUES.join(", ")}`,
  );
}

/** A stored model setting (or undefined when unset); throws for a setting of another runtime, which
 * sessions cannot use. */
export function piModelSetting(key: ModelSettingsKey): ModelSetting | undefined {
  const config = getSetting(key);
  if (!config) return undefined;
  if (config.runtimeType !== "pi") {
    throw new Error(`Configured ${key} uses unavailable runtime '${config.runtimeType}'. Update it in Settings.`);
  }
  return config;
}

/** The model task generation runs with: the `utility_model` setting, else `default_model`'s (undefined:
 * neither is set); throws for a setting of another runtime. */
export function resolveUtilityModelConfig(): ModelSetting | undefined {
  const config = getSetting("utility_model") ?? getSetting("default_model") ?? undefined;
  if (config && config.runtimeType !== "pi") {
    throw new Error(`Configured utility model uses unavailable runtime '${config.runtimeType}'. Update it in Settings.`);
  }
  return config;
}

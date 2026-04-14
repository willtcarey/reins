import { getModels, getProviders, type Api, type Model } from "@mariozechner/pi-ai";
import { type ModelRegistry } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";
import { getSetting, type ModelSettingsKey, type ModelSetting } from "../settings-store.js";
import { createPiContext } from "../runtimes/pi/factory.js";

export const THINKING_LEVEL_VALUES = ["minimal", "low", "medium", "high", "xhigh"] as const;

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

export function resolveModel(
  providerName: string,
  modelId: string,
  modelRegistry?: Pick<ModelRegistry, "find">,
): Model<Api> | undefined {
  if (modelRegistry) {
    const model: Model<Api> | undefined = modelRegistry.find(providerName, modelId);
    return model;
  }

  const provider = getProviders().find((candidate) => candidate === providerName);
  if (!provider) return undefined;

  return getModels(provider).find((candidate) => candidate.id === modelId);
}

export async function resolveModelFromPiRegistry(
  cwd: string,
  providerName: string,
  modelId: string,
): Promise<Model<Api> | undefined> {
  const { modelRegistry } = await createPiContext({ cwd });
  return resolveModel(providerName, modelId, modelRegistry);
}

export function resolveModelSettingWithConfig(key: ModelSettingsKey): {
  config: ModelSetting;
  model: Model<Api>;
} | undefined {
  const config = getSetting(key);
  if (!config) return undefined;

  const model = resolveModel(config.provider, config.modelId);
  if (!model) {
    throw new Error(
      `Configured ${key} is invalid: ${config.provider}/${config.modelId}. Update it in Settings.`,
    );
  }

  return { config, model };
}

export function resolveModelSettingWithConfigInRegistry(
  key: ModelSettingsKey,
  modelRegistry: Pick<ModelRegistry, "find">,
): {
  config: ModelSetting;
  model: Model<Api>;
} | undefined {
  const config = getSetting(key);
  if (!config) return undefined;

  const model = resolveModel(config.provider, config.modelId, modelRegistry);
  if (!model) {
    throw new Error(
      `Configured ${key} is invalid: ${config.provider}/${config.modelId}. Update it in Settings.`,
    );
  }

  return { config, model };
}

export async function resolveModelSettingWithConfigForCwd(cwd: string, key: ModelSettingsKey): Promise<{
  config: ModelSetting;
  model: Model<Api>;
} | undefined> {
  const { modelRegistry } = await createPiContext({ cwd });

  return resolveModelSettingWithConfigInRegistry(key, modelRegistry);
}

export function resolveModelSetting(key: ModelSettingsKey): Model<Api> | undefined {
  return resolveModelSettingWithConfig(key)?.model;
}

export async function resolveModelSettingForCwd(cwd: string, key: ModelSettingsKey): Promise<Model<Api> | undefined> {
  return (await resolveModelSettingWithConfigForCwd(cwd, key))?.model;
}

export function resolveUtilityModelConfig(): ModelSetting | undefined {
  return getSetting("utility_model") ?? getSetting("default_model") ?? undefined;
}

export function resolveUtilityModel(): Model<Api> | undefined {
  return resolveModelSetting("utility_model") ?? resolveModelSetting("default_model");
}

export async function resolveUtilityModelForCwd(cwd: string): Promise<Model<Api> | undefined> {
  const { modelRegistry } = await createPiContext({ cwd });

  return resolveModelSettingWithConfigInRegistry("utility_model", modelRegistry)?.model
    ?? resolveModelSettingWithConfigInRegistry("default_model", modelRegistry)?.model;
}

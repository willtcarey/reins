import { getModels, getProviders, type Api, type Model } from "@mariozechner/pi-ai";
import { getSetting, type ModelSettingsKey, type ModelSetting } from "../settings-store.js";

export function resolveModel(providerName: string, modelId: string): Model<Api> | undefined {
  const provider = getProviders().find((candidate) => candidate === providerName);
  if (!provider) return undefined;

  return getModels(provider).find((candidate) => candidate.id === modelId);
}

export function resolveModelSettingWithConfig(key: ModelSettingsKey): {
  config: ModelSetting;
  model: Model<Api>;
} | undefined {
  const config = getSetting(key);
  if (!config) return undefined;

  const model = resolveModel(config.provider, config.modelId);
  if (!model) return undefined;

  return { config, model };
}

export function resolveModelSetting(key: ModelSettingsKey): Model<Api> | undefined {
  return resolveModelSettingWithConfig(key)?.model;
}

export function resolveUtilityModel(): Model<Api> | undefined {
  return resolveModelSetting("utility_model") ?? resolveModelSetting("default_model");
}

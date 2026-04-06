import { getModels, getProviders, type Api, type Model } from "@mariozechner/pi-ai";
import { getSetting, type ModelSettingsKey, type ModelSetting } from "./settings-store.js";

export function resolveModelSetting(key: ModelSettingsKey): Model<Api> | undefined {
  const configured = getSetting(key);
  if (!configured) return undefined;

  const provider = getProviders().find((candidate) => candidate === configured.provider);
  if (!provider) return undefined;

  return getModels(provider).find((candidate) => candidate.id === configured.modelId);
}

export function resolveModelSettingWithConfig(key: ModelSettingsKey): {
  config: ModelSetting;
  model: Model<Api>;
} | undefined {
  const config = getSetting(key);
  if (!config) return undefined;

  const model = resolveModelSetting(key);
  if (!model) return undefined;

  return { config, model };
}

export function resolveUtilityModel(): Model<Api> | undefined {
  return resolveModelSetting("utility_model") ?? resolveModelSetting("default_model");
}

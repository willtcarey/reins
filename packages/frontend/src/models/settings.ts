import type { ProviderInfo } from "./model-catalog.js";
import type { ModelSetting } from "./stores/settings-store.js";

export function providerLabel(provider: string): string {
  return provider
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function formatModelSelectionOptionLabel(provider: string, modelName: string): string {
  return `${providerLabel(provider)} / ${modelName}`;
}

export function encodeModelSelection(provider: string, modelId: string): string {
  if (!provider || !modelId) return "";
  return JSON.stringify([provider, modelId]);
}

export function decodeModelSelection(value: string): { provider: string; modelId: string } | null {
  if (!value) return null;

  try {
    const parsed = JSON.parse(value);
    if (
      Array.isArray(parsed)
      && parsed.length === 2
      && typeof parsed[0] === "string"
      && typeof parsed[1] === "string"
    ) {
      return { provider: parsed[0], modelId: parsed[1] };
    }
  } catch {
    return null;
  }

  return null;
}

export function findModelInfo(providers: ProviderInfo[], providerName: string, modelId: string) {
  const provider = providers.find((candidate) => candidate.provider === providerName);
  return provider?.models.find((candidate) => candidate.id === modelId) ?? null;
}

export function formatModelSettingLabel(params: {
  providers: ProviderInfo[];
  model: ModelSetting;
  defaultThinkingLevel?: string;
  includeProviderWhenAmbiguous?: boolean;
}): string {
  const {
    providers,
    model,
    defaultThinkingLevel = "high",
    includeProviderWhenAmbiguous = true,
  } = params;

  const modelInfo = findModelInfo(providers, model.provider, model.modelId);
  const modelName = modelInfo?.name ?? model.modelId;

  const providerNeeded = includeProviderWhenAmbiguous
    && providers.some((provider) =>
      provider.provider !== model.provider && provider.models.some((candidate) => candidate.id === model.modelId));

  const thinking = THINKING_LEVELS.find((level) => level.value === model.thinkingLevel)?.label ?? model.thinkingLevel;
  const parts = [providerNeeded ? formatModelSelectionOptionLabel(model.provider, modelName) : modelName];

  if (model.thinkingLevel !== defaultThinkingLevel) {
    parts.push(thinking);
  }

  return parts.join(" · ");
}

export const THINKING_LEVELS = [
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra High" },
] as const;

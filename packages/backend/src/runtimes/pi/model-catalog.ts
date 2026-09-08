import { getEnvApiKey } from "@earendil-works/pi-ai/compat";
import { hasAuthCredential } from "../../auth-credentials-store.js";
import type {
  AvailabilitySourceType,
  ProviderInfo,
} from "../registry.js";
import { createPiContext } from "./factory.js";

function availabilitySources(providerId: string): AvailabilitySourceType[] {
  const sources: AvailabilitySourceType[] = [];
  if (hasAuthCredential(providerId, "api_key")) sources.push("db");
  if (getEnvApiKey(providerId)) sources.push("env");
  if (hasAuthCredential(providerId, "oauth")) sources.push("oauth");
  return sources;
}

export async function buildProviderList(cwd = process.cwd()): Promise<ProviderInfo[]> {
  const { modelRuntime } = await createPiContext({ cwd, allowModelNetwork: true });

  return Promise.all(modelRuntime.getProviders().map(async (provider) => {
    const auth = await modelRuntime.checkAuth(provider.id);
    const sources = availabilitySources(provider.id);

    return {
      provider: provider.id,
      isAvailable: !!auth,
      availabilitySource: sources[0] ?? null,
      availabilitySources: sources,
      models: modelRuntime.getModels(provider.id).map((model) => ({
        id: model.id,
        name: model.name,
        reasoning: model.reasoning,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      })),
    };
  })).then((providers) => providers.toSorted((a, b) => a.provider.localeCompare(b.provider)));
}

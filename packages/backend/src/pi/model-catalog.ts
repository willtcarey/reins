import { getEnvApiKey } from "@earendil-works/pi-ai/compat";
import { hasAuthCredential } from "../auth-credentials-store.js";
import type { AvailabilitySourceType, ProviderInfo } from "./registry.js";
import { createPiModelRuntime } from "./factory.js";

/**
 * The server's model catalog: Pi's providers and models with where each provider's credentials come
 * from. Sessions run on nodes; the server uses the catalog to list and validate models.
 */

/** A provider as `GET /api/models` and `models.list` report it, with the runtime type its models use. */
export interface RuntimeProviderInfo extends ProviderInfo {
  runtimeType: string;
}

function availabilitySources(providerId: string): AvailabilitySourceType[] {
  const sources: AvailabilitySourceType[] = [];
  if (hasAuthCredential(providerId, "api_key")) sources.push("db");
  if (getEnvApiKey(providerId)) sources.push("env");
  if (hasAuthCredential(providerId, "oauth")) sources.push("oauth");
  return sources;
}

export async function findPiModel(provider: string, modelId: string) {
  const modelRuntime = await createPiModelRuntime();
  return modelRuntime.getModel(provider, modelId);
}

export async function buildProviderList(): Promise<ProviderInfo[]> {
  const modelRuntime = await createPiModelRuntime({ allowModelNetwork: true });

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

/** The catalog with each provider's runtime type (always `pi`: the only runtime sessions use). */
export async function listRuntimeProviders(): Promise<RuntimeProviderInfo[]> {
  return (await buildProviderList()).map(provider => ({ runtimeType: "pi", ...provider }));
}

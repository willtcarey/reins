import {
  getEnvApiKey,
} from "@mariozechner/pi-ai";
import {
  getOAuthProviders,
} from "@mariozechner/pi-ai/oauth";
import {
  hasAuthCredential,
} from "../../auth-credentials-store.js";
import type {
  AvailabilitySourceType,
  ProviderInfo,
} from "../registry.js";
import {
  createPiContext,
  type PiContext,
} from "./factory.js";

export async function createPiModelRegistry(params: {
  cwd: string;
}): Promise<PiContext> {
  return createPiContext(params);
}

function getOAuthProviderIds(): Set<string> {
  return new Set(getOAuthProviders().map((provider) => provider.id));
}

export async function buildProviderList(cwd = process.cwd()): Promise<ProviderInfo[]> {
  const oauthProviderIds = getOAuthProviderIds();
  const { modelRegistry } = await createPiModelRegistry({ cwd });

  return Array.from(new Set(modelRegistry.getAll().map((model) => model.provider))).toSorted().map((provider) => {
    const hasDbApiKey = hasAuthCredential(provider, "api_key");
    const hasEnvKey = !!getEnvApiKey(provider);
    const hasOAuth = oauthProviderIds.has(provider) && hasAuthCredential(provider, "oauth");

    const availabilitySources: AvailabilitySourceType[] = [];
    if (hasDbApiKey) availabilitySources.push("db");
    if (hasEnvKey) availabilitySources.push("env");
    if (hasOAuth) availabilitySources.push("oauth");

    return {
      provider,
      isAvailable: availabilitySources.length > 0,
      availabilitySource: availabilitySources[0] ?? null,
      availabilitySources,
      models: modelRegistry.getAll()
        .filter((model) => model.provider === provider)
        .map((model) => ({
          id: model.id,
          name: model.name,
          reasoning: model.reasoning,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
        })),
    };
  });
}

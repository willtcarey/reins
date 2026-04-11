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
  KeySourceType,
  ProviderInfo,
} from "../registry.js";
import {
  createPiContext,
  type PiContext,
} from "./factory.js";

export type { KeySourceType, ProviderInfo, ModelInfo } from "../registry.js";

export type PiModelRegistryResult = PiContext;

export async function createPiModelRegistry(params: {
  cwd: string;
}): Promise<PiModelRegistryResult> {
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

    const keySources: KeySourceType[] = [];
    if (hasDbApiKey) keySources.push("db");
    if (hasEnvKey) keySources.push("env");
    if (hasOAuth) keySources.push("oauth");

    return {
      provider,
      hasKey: keySources.length > 0,
      keySource: keySources[0] ?? null,
      keySources,
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

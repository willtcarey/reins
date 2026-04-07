import {
  getProviders,
  getModels,
  getEnvApiKey,
} from "@mariozechner/pi-ai";
import {
  getOAuthProviders,
} from "@mariozechner/pi-ai/oauth";
import {
  hasAuthCredential,
} from "../auth-credentials-store.js";

export type KeySourceType = "db" | "env" | "oauth";

export interface ProviderInfo {
  provider: string;
  hasKey: boolean;
  keySource: KeySourceType | null;
  keySources: KeySourceType[];
  models: ModelInfo[];
}

export interface ModelInfo {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
}

function getOAuthProviderIds(): Set<string> {
  return new Set(getOAuthProviders().map((provider) => provider.id));
}

export function buildProviderList(): ProviderInfo[] {
  const oauthProviderIds = getOAuthProviderIds();

  return getProviders().map((provider) => {
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
      models: getModels(provider).map((model) => ({
        id: model.id,
        name: model.name,
        reasoning: model.reasoning,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      })),
    };
  });
}

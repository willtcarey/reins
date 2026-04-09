import {
  getEnvApiKey,
} from "@mariozechner/pi-ai";
import {
  getOAuthProviders,
} from "@mariozechner/pi-ai/oauth";
import {
  hasAuthCredential,
} from "../auth-credentials-store.js";
import {
  createPiRuntimeForCwd,
  type PiProviderRegistration,
  type PiRuntimeForCwdResult,
  getPiProviderRegistrations,
  applyPiProviderRegistrations,
} from "./runtime.js";

export type KeySourceType = "db" | "env" | "oauth" | "local";

export type PiModelRegistryResult = PiRuntimeForCwdResult;

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

export async function createPiModelRegistry(params: {
  cwd: string;
}): Promise<PiModelRegistryResult> {
  return createPiRuntimeForCwd(params);
}

export function hasPiExtensionProvider(
  providerRegistrations: PiProviderRegistration[],
  providerName: string,
): boolean {
  return providerRegistrations.some((registration) => registration.name === providerName);
}

export function getPiProviderEnvVar(
  providerRegistrations: PiProviderRegistration[],
  providerName: string,
): string | null {
  const config = providerRegistrations.find((registration) => registration.name === providerName)?.config;
  return typeof config?.apiKey === "string" ? config.apiKey : null;
}

export function getPiOAuthProviderIds(
  providerRegistrations: PiProviderRegistration[],
): Set<string> {
  return new Set(
    providerRegistrations
      .filter((registration) => !!registration.config.oauth)
      .map((registration) => registration.name),
  );
}

const LOCAL_AUTH_APIS = new Set(["claude-agent-sdk"]);

export function hasPiLocalAuth(
  providerRegistrations: PiProviderRegistration[],
  providerName: string,
): boolean {
  const config = providerRegistrations.find((registration) => registration.name === providerName)?.config;
  const api = typeof config?.api === "string" ? config.api : null;
  return api !== null && LOCAL_AUTH_APIS.has(api);
}

function getOAuthProviderIds(): Set<string> {
  return new Set(getOAuthProviders().map((provider) => provider.id));
}

export async function buildProviderList(cwd = process.cwd()): Promise<ProviderInfo[]> {
  const oauthProviderIds = getOAuthProviderIds();
  const { modelRegistry, providerRegistrations } = await createPiModelRegistry({ cwd });
  const dynamicOAuthProviderIds = getPiOAuthProviderIds(providerRegistrations);

  return Array.from(new Set(modelRegistry.getAll().map((model) => model.provider))).toSorted().map((provider) => {
    const hasDbApiKey = hasAuthCredential(provider, "api_key");
    const dynamicEnvVar = getPiProviderEnvVar(providerRegistrations, provider);
    const hasEnvKey = dynamicEnvVar
      ? !!process.env[dynamicEnvVar]
      : !!getEnvApiKey(provider);
    const hasOAuth = (oauthProviderIds.has(provider) || dynamicOAuthProviderIds.has(provider))
      && hasAuthCredential(provider, "oauth");
    const hasLocalAuth = hasPiLocalAuth(providerRegistrations, provider);

    const keySources: KeySourceType[] = [];
    if (hasDbApiKey) keySources.push("db");
    if (hasEnvKey) keySources.push("env");
    if (hasOAuth) keySources.push("oauth");
    if (hasLocalAuth && keySources.length === 0) keySources.push("local");

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

export {
  getPiProviderRegistrations,
  applyPiProviderRegistrations,
};

export type { PiProviderRegistration };

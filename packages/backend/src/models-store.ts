/**
 * Models Store
 *
 * Shared provider/model discovery logic for the models route and scripting API.
 */

import {
  getProviders,
  getModels,
  getEnvApiKey,
} from "@mariozechner/pi-ai";
import {
  getOAuthProviders,
} from "@mariozechner/pi-ai/oauth";
import type { OAuthCredentials } from "@mariozechner/pi-ai/oauth";
import { getSetting, type SettingsKey, isValidSettingsKey } from "./settings-store.js";

export type KeySourceType = "db" | "env" | "oauth";

export interface ProviderInfo {
  provider: string;
  hasKey: boolean;
  /** The highest-priority key source (db > env > oauth). */
  keySource: KeySourceType | null;
  /** All configured key sources for this provider. */
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

/** Map from provider name to the settings key that stores its API key. */
function apiKeySettingForProvider(provider: string): SettingsKey | null {
  const key = `api_key_${provider}`;
  return isValidSettingsKey(key) ? key : null;
}

/** The settings key for a provider's OAuth credentials. */
function oauthSettingForProvider(provider: string): SettingsKey {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- dynamic key validated by settings store
  return `oauth_${provider}` as SettingsKey;
}

/** Build the set of OAuth provider IDs for quick lookup. */
function getOAuthProviderIds(): Set<string> {
  return new Set(getOAuthProviders().map((p) => p.id));
}

/**
 * Build the full provider/model list.
 */
export function buildProviderList(): ProviderInfo[] {
  const providers = getProviders();
  const oauthProviderIds = getOAuthProviderIds();
  const result: ProviderInfo[] = [];

  for (const provider of providers) {
    const settingKey = apiKeySettingForProvider(provider);
    const dbKey = settingKey ? getSetting(settingKey) : null;
    const envKey = getEnvApiKey(provider);

    let oauthCreds: OAuthCredentials | null = null;
    if (oauthProviderIds.has(provider)) {
      const oauthKey = oauthSettingForProvider(provider);
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- dynamic key; runtime validated by settings store
      oauthCreds = getSetting(oauthKey) as OAuthCredentials | null;
    }

    const hasKey = dbKey !== null || !!envKey || oauthCreds !== null;

    const keySources: KeySourceType[] = [];
    if (dbKey !== null) keySources.push("db");
    if (envKey) keySources.push("env");
    if (oauthCreds !== null) keySources.push("oauth");

    const keySource: KeySourceType | null = keySources[0] ?? null;

    const models = getModels(provider).map((m) => ({
      id: m.id,
      name: m.name,
      reasoning: m.reasoning,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
    }));

    result.push({ provider, hasKey, keySource, keySources, models });
  }

  return result;
}

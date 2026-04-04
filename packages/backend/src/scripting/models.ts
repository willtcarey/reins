/**
 * Models API function definitions and schemas.
 *
 * Provides agent-callable functions for discovering available AI providers
 * and models. Shares the same data shape as GET /api/models.
 */

import { Type } from "@sinclair/typebox";
import {
  getProviders,
  getModels,
  getEnvApiKey,
} from "@mariozechner/pi-ai";
import {
  getOAuthProviders,
} from "@mariozechner/pi-ai/oauth";
import type { OAuthCredentials } from "@mariozechner/pi-ai/oauth";
import { getSetting, type SettingsKey, isValidSettingsKey } from "../settings-store.js";
import { type ApiFunctionDef, defineFunction } from "./define-function.js";

// ---------------------------------------------------------------------------
// Shared types & helpers
// ---------------------------------------------------------------------------

export interface ProviderInfo {
  provider: string;
  hasKey: boolean;
  keySource: "db" | "env" | "oauth" | null;
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
 * Build the full provider/model list. Shared between the route and scripting API.
 */
export function buildProviderList(encryptionSecret: Buffer): ProviderInfo[] {
  const providers = getProviders();
  const oauthProviderIds = getOAuthProviderIds();
  const result: ProviderInfo[] = [];

  for (const provider of providers) {
    const settingKey = apiKeySettingForProvider(provider);
    const dbKey = settingKey ? getSetting(settingKey, encryptionSecret) : null;
    const envKey = getEnvApiKey(provider);

    // Check for OAuth credentials
    let oauthCreds: OAuthCredentials | null = null;
    if (oauthProviderIds.has(provider)) {
      const oauthKey = oauthSettingForProvider(provider);
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- dynamic key; runtime validated by settings store
      oauthCreds = getSetting(oauthKey, encryptionSecret) as OAuthCredentials | null;
    }

    const hasKey = dbKey !== null || !!envKey || oauthCreds !== null;
    const keySource: "db" | "env" | "oauth" | null = dbKey !== null
      ? "db"
      : envKey
        ? "env"
        : oauthCreds !== null
          ? "oauth"
          : null;

    const models = getModels(provider).map((m) => ({
      id: m.id,
      name: m.name,
      reasoning: m.reasoning,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
    }));

    result.push({ provider, hasKey, keySource, models });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Function definitions
// ---------------------------------------------------------------------------

export const MODEL_FUNCTIONS: ApiFunctionDef[] = [
  defineFunction({
    name: "models.list",
    description:
      "List all available AI providers with their models, including whether an API key " +
      "is configured and the key source (db or env). Each provider includes its models " +
      "with id, name, reasoning capability, context window, and max tokens.",
    parameters: Type.Object({}),
    returns: Type.Array(Type.Unknown()),
    tags: ["models", "providers", "list", "read", "ai", "configuration"],
    execute: (_params, ctx) => buildProviderList(ctx.encryptionSecret),
  }),
  defineFunction({
    name: "models.listProviders",
    description: "List available AI provider names (e.g. 'anthropic', 'openai').",
    parameters: Type.Object({}),
    returns: Type.Array(Type.String()),
    tags: ["models", "providers", "list", "read", "names"],
    execute: () => [...getProviders()],
  }),
];

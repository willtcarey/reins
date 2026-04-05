import {
  AuthStorage,
  type AuthCredential,
  type AuthStorageBackend,
  type OAuthCredential,
} from "@mariozechner/pi-coding-agent";
import { getDb } from "./db.js";
import {
  deleteSetting,
  getSetting,
  isValidSettingsKey,
  setSetting,
  type OAuthCredentialValue,
  type SettingsKey,
} from "./settings-store.js";

const API_KEY_PREFIX = "api_key_";
const OAUTH_PREFIX = "oauth_";
type DbAuthStorageData = Record<string, AuthCredential>;
type AuthStorageChangeListener = () => void;

const authStorageChangeListeners = new Set<AuthStorageChangeListener>();

export function isApiKeySettingKey(key: string): key is `api_key_${string}` {
  return key.startsWith(API_KEY_PREFIX);
}

export function isOAuthSettingKey(key: string): key is `oauth_${string}` {
  return key.startsWith(OAUTH_PREFIX);
}

export function providerFromApiKeySettingKey(key: `api_key_${string}`): string {
  return key.slice(API_KEY_PREFIX.length);
}

export function providerFromOAuthSettingKey(key: `oauth_${string}`): string {
  return key.slice(OAUTH_PREFIX.length);
}

function apiKeySettingKey(provider: string): `api_key_${string}` {
  return `api_key_${provider}`;
}

function oauthSettingKey(provider: string): `oauth_${string}` {
  return `oauth_${provider}`;
}

function listAuthSettingKeys(): SettingsKey[] {
  const rows = getDb()
    .query<{ key: string }, []>("SELECT key FROM settings WHERE key LIKE 'api_key_%' OR key LIKE 'oauth_%' ORDER BY key")
    .all();

  const keys: SettingsKey[] = [];
  for (const row of rows) {
    if (isValidSettingsKey(row.key) && (isApiKeySettingKey(row.key) || isOAuthSettingKey(row.key))) {
      keys.push(row.key);
    }
  }
  return keys;
}

function readAuthStorageDataFromSettings(): DbAuthStorageData {
  const data: DbAuthStorageData = {};

  for (const key of listAuthSettingKeys()) {
    if (isApiKeySettingKey(key)) {
      const value = getSetting(key);
      if (typeof value === "string") {
        data[providerFromApiKeySettingKey(key)] = {
          type: "api_key",
          key: value,
        };
      }
      continue;
    }

    if (isOAuthSettingKey(key)) {
      const value = getSetting(key);
      if (value && typeof value === "object") {
        data[providerFromOAuthSettingKey(key)] = {
          type: "oauth",
          ...value,
        };
      }
    }
  }

  return data;
}

function notifyAuthStorageChanges(): void {
  for (const listener of authStorageChangeListeners) {
    listener();
  }
}

export function subscribeAuthStorageChanges(listener: AuthStorageChangeListener): () => void {
  authStorageChangeListeners.add(listener);
  return () => {
    authStorageChangeListeners.delete(listener);
  };
}

function writeAuthStorageDataToSettings(data: DbAuthStorageData): void {
  const existingKeys = new Set(listAuthSettingKeys());
  const nextKeys = new Set<SettingsKey>();

  for (const [provider, credential] of Object.entries(data)) {
    if (credential.type === "api_key") {
      const key = apiKeySettingKey(provider);
      nextKeys.add(key);
      setSetting(key, credential.key);
      continue;
    }

    const key = oauthSettingKey(provider);
    nextKeys.add(key);
    const value: OAuthCredentialValue = {
      refresh: credential.refresh,
      access: credential.access,
      expires: credential.expires,
      ...Object.fromEntries(
        Object.entries(credential).filter(([name]) => !["type", "refresh", "access", "expires"].includes(name)),
      ),
    };
    setSetting(key, value);
  }

  for (const key of existingKeys) {
    if (!nextKeys.has(key)) {
      deleteSetting(key);
    }
  }
}

/**
 * AuthStorage backend that treats DB-backed settings as the source of truth.
 *
 * It exposes `api_key_*` and `oauth_*` settings as the JSON blob expected by
 * pi's `AuthStorage.fromStorage(...)` API.
 */
export class DbAuthStorageBackend implements AuthStorageBackend {
  withLock<T>(fn: (current: string | undefined) => { result: T; next?: string }): T {
    const db = getDb();
    db.exec("BEGIN IMMEDIATE");
    try {
      const currentData = readAuthStorageDataFromSettings();
      const current = JSON.stringify(currentData);
      const { result, next } = fn(current);
      const changed = next !== undefined && next !== current;
      if (next !== undefined) {
        const parsed: DbAuthStorageData = JSON.parse(next);
        writeAuthStorageDataToSettings(parsed);
      }
      db.exec("COMMIT");
      if (changed) notifyAuthStorageChanges();
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  async withLockAsync<T>(fn: (current: string | undefined) => Promise<{ result: T; next?: string }>): Promise<T> {
    const db = getDb();
    db.exec("BEGIN IMMEDIATE");
    try {
      const currentData = readAuthStorageDataFromSettings();
      const current = JSON.stringify(currentData);
      const { result, next } = await fn(current);
      const changed = next !== undefined && next !== current;
      if (next !== undefined) {
        const parsed: DbAuthStorageData = JSON.parse(next);
        writeAuthStorageDataToSettings(parsed);
      }
      db.exec("COMMIT");
      if (changed) notifyAuthStorageChanges();
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

export function syncApiKeySettingToAuthStorage(
  authStorage: AuthStorage,
  key: SettingsKey,
  value: string | null,
): void {
  if (!isApiKeySettingKey(key)) return;

  const provider = providerFromApiKeySettingKey(key);
  if (value === null) {
    authStorage.remove(provider);
  } else {
    const credential: AuthCredential = {
      type: "api_key",
      key: value,
    };
    authStorage.set(provider, credential);
  }
}

export function syncOAuthSettingToAuthStorage(
  authStorage: AuthStorage,
  key: SettingsKey,
  value: OAuthCredentialValue | null,
): void {
  if (!isOAuthSettingKey(key)) return;

  const provider = providerFromOAuthSettingKey(key);
  if (value === null) {
    authStorage.remove(provider);
    return;
  }

  const credential: OAuthCredential = {
    type: "oauth",
    ...value,
  };
  authStorage.set(provider, credential);
}

export function loadDbApiKeyRuntimeOverrides(authStorage: AuthStorage): void {
  const rows = getDb()
    .query<{ key: string }, []>("SELECT key FROM settings WHERE key LIKE 'api_key_%' ORDER BY key")
    .all();

  for (const row of rows) {
    if (!isValidSettingsKey(row.key) || !isApiKeySettingKey(row.key)) continue;

    const value = getSetting(row.key);
    if (typeof value === "string") {
      syncApiKeySettingToAuthStorage(authStorage, row.key, value);
    }
  }
}

export function loadDbOAuthCredentials(authStorage: AuthStorage): void {
  const rows = getDb()
    .query<{ key: string }, []>("SELECT key FROM settings WHERE key LIKE 'oauth_%' ORDER BY key")
    .all();

  for (const row of rows) {
    if (!isValidSettingsKey(row.key) || !isOAuthSettingKey(row.key)) continue;

    const value = getSetting(row.key);
    if (value && typeof value === "object") {
      const credentials: OAuthCredentialValue = value;
      syncOAuthSettingToAuthStorage(authStorage, row.key, credentials);
    }
  }
}

export function createDbBackedAuthStorage(): AuthStorage {
  return AuthStorage.fromStorage(new DbAuthStorageBackend());
}

export function createSharedAuthStorage(): AuthStorage {
  return createDbBackedAuthStorage();
}

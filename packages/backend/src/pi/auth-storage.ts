import {
  AuthStorage,
  type AuthCredential,
  type AuthStorageBackend,
} from "@mariozechner/pi-coding-agent";
import { getDb } from "../db.js";
import {
  deleteAllAuthCredentials,
  getPreferredAuthCredential,
  listAuthProviders,
  setApiKeyCredential,
  setOAuthCredential,
} from "../auth-credentials-store.js";

type DbAuthStorageData = Record<string, AuthCredential>;
type AuthStorageChangeListener = () => void;

const authStorageChangeListeners = new Set<AuthStorageChangeListener>();

function readAuthStorageData(): DbAuthStorageData {
  const data: DbAuthStorageData = {};

  for (const provider of listAuthProviders()) {
    const credential = getPreferredAuthCredential(provider);
    if (!credential) continue;

    if (credential.type === "api_key") {
      data[provider] = {
        type: "api_key",
        key: credential.value,
      };
      continue;
    }

    data[provider] = {
      type: "oauth",
      ...credential.value,
    };
  }

  return data;
}

function writeAuthStorageData(data: DbAuthStorageData): void {
  const existingProviders = new Set(listAuthProviders());
  const nextProviders = new Set(Object.keys(data));

  for (const provider of existingProviders) {
    if (!nextProviders.has(provider)) {
      deleteAllAuthCredentials(provider);
    }
  }

  for (const [provider, credential] of Object.entries(data)) {
    if (credential.type === "api_key") {
      setApiKeyCredential(provider, credential.key);
      getDb().query("DELETE FROM auth_credentials WHERE provider = ? AND type = 'oauth'").run(provider);
      continue;
    }

    setOAuthCredential(provider, {
      refresh: credential.refresh,
      access: credential.access,
      expires: credential.expires,
      ...Object.fromEntries(
        Object.entries(credential).filter(([name]) => !["type", "refresh", "access", "expires"].includes(name)),
      ),
    });
    getDb().query("DELETE FROM auth_credentials WHERE provider = ? AND type = 'api_key'").run(provider);
  }
}

function parseAuthStorageData(json: string): DbAuthStorageData {
  const parsed: DbAuthStorageData = JSON.parse(json);
  return parsed;
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

export class DbAuthStorageBackend implements AuthStorageBackend {
  withLock<T>(fn: (current: string | undefined) => { result: T; next?: string }): T {
    const db = getDb();
    db.exec("BEGIN IMMEDIATE");
    try {
      const current = JSON.stringify(readAuthStorageData());
      const { result, next } = fn(current);
      const changed = next !== undefined && next !== current;
      if (next !== undefined) {
        writeAuthStorageData(parseAuthStorageData(next));
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
      const current = JSON.stringify(readAuthStorageData());
      const { result, next } = await fn(current);
      const changed = next !== undefined && next !== current;
      if (next !== undefined) {
        writeAuthStorageData(parseAuthStorageData(next));
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

export function createDbBackedAuthStorage(): AuthStorage {
  return AuthStorage.fromStorage(new DbAuthStorageBackend());
}

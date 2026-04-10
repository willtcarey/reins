import type { ManagedSession } from "../state.js";
import { isPiRuntime } from "../runtimes/pi/runtime.js";
import {
  deleteAuthCredential,
  hasAuthCredential,
  listAuthProviders,
  setApiKeyCredential,
  setOAuthCredential,
  type AuthCredentialType,
  type OAuthCredentialValue,
} from "../auth-credentials-store.js";

export function reloadManagedSessionAuthStorage(sessions: Map<string, ManagedSession>): void {
  for (const managed of sessions.values()) {
    if (!isPiRuntime(managed.runtime)) continue;
    managed.runtime.session.modelRegistry.authStorage.reload();
  }
}

export function listConfiguredApiKeyProviders(): string[] {
  return listAuthProviders().filter((provider) => hasAuthCredential(provider, "api_key"));
}

export function hasStoredAuthCredential(provider: string, type: AuthCredentialType): boolean {
  return hasAuthCredential(provider, type);
}

export function setApiKey(
  provider: string,
  apiKey: string,
  sessions: Map<string, ManagedSession>,
): void {
  setApiKeyCredential(provider, apiKey);
  reloadManagedSessionAuthStorage(sessions);
}

export function deleteApiKey(
  provider: string,
  sessions: Map<string, ManagedSession>,
): void {
  deleteAuthCredential(provider, "api_key");
  reloadManagedSessionAuthStorage(sessions);
}

export function setOAuthCredentialValue(
  provider: string,
  value: OAuthCredentialValue,
  sessions: Map<string, ManagedSession>,
): void {
  setOAuthCredential(provider, value);
  reloadManagedSessionAuthStorage(sessions);
}

export function deleteOAuthCredential(
  provider: string,
  sessions: Map<string, ManagedSession>,
): void {
  deleteAuthCredential(provider, "oauth");
  reloadManagedSessionAuthStorage(sessions);
}

import {
  deleteAuthCredential,
  hasAuthCredential,
  listAuthProviders,
  setApiKeyCredential,
  setOAuthCredential,
  type AuthCredentialType,
  type OAuthCredentialValue,
} from "../auth-credentials-store.js";

export function listConfiguredApiKeyProviders(): string[] {
  return listAuthProviders().filter((provider) => hasAuthCredential(provider, "api_key"));
}

export function hasStoredAuthCredential(provider: string, type: AuthCredentialType): boolean {
  return hasAuthCredential(provider, type);
}

export function setApiKey(
  provider: string,
  apiKey: string,
): void {
  setApiKeyCredential(provider, apiKey);
}

export function deleteApiKey(
  provider: string,
): void {
  deleteAuthCredential(provider, "api_key");
}

export function setOAuthCredentialValue(
  provider: string,
  value: OAuthCredentialValue,
): void {
  setOAuthCredential(provider, value);
}

export function deleteOAuthCredential(
  provider: string,
): void {
  deleteAuthCredential(provider, "oauth");
}

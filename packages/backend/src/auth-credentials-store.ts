import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { decrypt, encrypt } from "./crypto.js";
import { getDb } from "./db.js";

const PROVIDER_PATTERN = /^[a-z][a-z0-9-]*$/;
const API_KEY_SCHEMA = Type.String();
const OAUTH_SCHEMA = Type.Intersect([
  Type.Object({
    refresh: Type.String(),
    access: Type.String(),
    expires: Type.Number(),
  }),
  Type.Record(Type.String(), Type.Unknown()),
]);
const REDACTED_PLACEHOLDER = "********";

export type AuthCredentialType = "api_key" | "oauth";
export type OAuthCredentialValue = {
  refresh: string;
  access: string;
  expires: number;
  [key: string]: unknown;
};

export interface ApiKeyCredentialRecord {
  provider: string;
  type: "api_key";
  value: string;
  updatedAt: string;
}

export interface OAuthCredentialRecord {
  provider: string;
  type: "oauth";
  value: OAuthCredentialValue;
  updatedAt: string;
}

export type AuthCredentialRecord = ApiKeyCredentialRecord | OAuthCredentialRecord;

export interface ListedAuthCredential {
  provider: string;
  type: AuthCredentialType;
  value: string;
  redacted: true;
  updatedAt: string;
}

function assertValidProvider(provider: string): void {
  if (!PROVIDER_PATTERN.test(provider)) {
    throw new Error(`Invalid auth provider: ${provider}`);
  }
}

function parseOAuthCredentialValue(value: string): OAuthCredentialValue {
  return JSON.parse(value);
}

function validateValue(type: AuthCredentialType, value: unknown): void {
  const schema = type === "api_key" ? API_KEY_SCHEMA : OAUTH_SCHEMA;
  if (!Value.Check(schema, value)) {
    const errors = [...Value.Errors(schema, value)];
    const messages = errors.map((error) => `${error.path}: ${error.message}`).join("; ");
    throw new Error(`Invalid ${type} credential: ${messages}`);
  }
}

function rowToRecord(
  row: { provider: string; type: AuthCredentialType; value: string; updated_at: string },
): AuthCredentialRecord {
  const decrypted = decrypt(row.value);

  switch (row.type) {
    case "api_key":
      return {
        provider: row.provider,
        type: "api_key",
        value: decrypted,
        updatedAt: row.updated_at,
      };
    case "oauth":
      return {
        provider: row.provider,
        type: "oauth",
        value: parseOAuthCredentialValue(decrypted),
        updatedAt: row.updated_at,
      };
  }
}

export function getAuthCredential(
  provider: string,
  type: AuthCredentialType,
): AuthCredentialRecord | null {
  assertValidProvider(provider);
  const row = getDb()
    .query<{ provider: string; type: AuthCredentialType; value: string; updated_at: string }, [string, AuthCredentialType]>(
      "SELECT provider, type, value, updated_at FROM auth_credentials WHERE provider = ? AND type = ?",
    )
    .get(provider, type);

  return row ? rowToRecord(row) : null;
}

export function hasAuthCredential(provider: string, type: AuthCredentialType): boolean {
  return getAuthCredential(provider, type) !== null;
}

export function getPreferredAuthCredential(provider: string): AuthCredentialRecord | null {
  return getAuthCredential(provider, "api_key") ?? getAuthCredential(provider, "oauth");
}

function setAuthCredential(
  provider: string,
  type: AuthCredentialType,
  value: unknown,
): void {
  assertValidProvider(provider);
  validateValue(type, value);

  const serialized = type === "api_key"
    ? String(value)
    : JSON.stringify(value);

  getDb().query(
    `INSERT INTO auth_credentials (provider, type, value, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(provider, type)
     DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(provider, type, encrypt(serialized));
}

export function setApiKeyCredential(provider: string, apiKey: string): void {
  setAuthCredential(provider, "api_key", apiKey);
}

export function setOAuthCredential(provider: string, value: OAuthCredentialValue): void {
  setAuthCredential(provider, "oauth", value);
}

export function deleteAuthCredential(provider: string, type: AuthCredentialType): void {
  assertValidProvider(provider);
  getDb().query("DELETE FROM auth_credentials WHERE provider = ? AND type = ?").run(provider, type);
}

export function deleteAllAuthCredentials(provider: string): void {
  assertValidProvider(provider);
  getDb().query("DELETE FROM auth_credentials WHERE provider = ?").run(provider);
}

export function listAuthProviders(): string[] {
  return getDb()
    .query<{ provider: string }, []>(
      "SELECT DISTINCT provider FROM auth_credentials ORDER BY provider",
    )
    .all()
    .map((row) => row.provider);
}

export function listAuthCredentials(): ListedAuthCredential[] {
  return getDb()
    .query<{ provider: string; type: AuthCredentialType; updated_at: string }, []>(
      "SELECT provider, type, updated_at FROM auth_credentials ORDER BY provider, type",
    )
    .all()
    .map((row) => ({
      provider: row.provider,
      type: row.type,
      value: REDACTED_PLACEHOLDER,
      redacted: true,
      updatedAt: row.updated_at,
    }));
}

/**
 * Backend extensions' secrets (`extension_secrets`): each extension's values by key, encrypted with the server's
 * key. The host gives each extension its own as `ServerSdk.secrets` (`extensions/host.ts`, ADR-033).
 */

import { decrypt, encrypt } from "./crypto.js";
import { getDb } from "./app-globals.js";

/** ADR-004. */
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

export function getExtensionSecret(extension: string, key: string): string | undefined {
  const row = getDb().query<{ value: string }, [string, string]>("SELECT value FROM extension_secrets WHERE extension = ? AND key = ?").get(extension, key);
  return row ? decrypt(row.value) : undefined;
}

export function setExtensionSecret(extension: string, key: string, value: string): void {
  getDb().query(
    `INSERT INTO extension_secrets (extension, key, value, updated_at) VALUES (?, ?, ?, ${NOW})
     ON CONFLICT(extension, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(extension, key, encrypt(value));
}

export function deleteExtensionSecret(extension: string, key: string): void {
  getDb().query("DELETE FROM extension_secrets WHERE extension = ? AND key = ?").run(extension, key);
}

/** In key order; those that start with `prefix`. */
export function extensionSecretKeys(extension: string, prefix = ""): string[] {
  // substr, not LIKE: a prefix's `%` and `_` are its own characters.
  return getDb().query<{ key: string }, [string, string, string]>(
    "SELECT key FROM extension_secrets WHERE extension = ? AND substr(key, 1, length(?)) = ? ORDER BY key",
  ).all(extension, prefix, prefix).map(row => row.key);
}

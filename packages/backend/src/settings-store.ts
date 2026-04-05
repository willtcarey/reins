/**
 * Settings Store
 *
 * Typed, schema-driven settings persistence backed by SQLite.
 * Each setting is defined in SETTINGS_SCHEMA with its TypeBox schema
 * and behavior flags (encrypted, redacted).
 *
 * - getSetting() reads and deserializes (decrypting if needed)
 * - setSetting() validates, serializes, encrypts if needed, and upserts
 * - deleteSetting() removes from DB
 * - listSettings() returns all settings with redaction applied
 */

import { Type, type TSchema, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { getDb } from "./db.js";
import { encrypt, decrypt } from "./crypto.js";

// ---- Schema Registry -------------------------------------------------------

interface SettingDef<T extends TSchema = TSchema> {
  schema: T;
  encrypted?: boolean;
  redacted?: boolean;
}

const SETTINGS_SCHEMA = {
  default_model: {
    schema: Type.Object({
      provider: Type.String(),
      modelId: Type.String(),
      thinkingLevel: Type.String(),
    }),
  },
} as const satisfies Record<string, SettingDef>;

/** Definition shared by all dynamic `api_key_*` settings. */
const API_KEY_DEF: SettingDef = {
  schema: Type.String(),
  encrypted: true,
  redacted: true,
};

/** Definition shared by all dynamic `oauth_*` settings (OAuth credentials). */
const OAUTH_DEF: SettingDef = {
  schema: Type.Intersect([
    Type.Object({
      refresh: Type.String(),
      access: Type.String(),
      expires: Type.Number(),
    }),
    Type.Record(Type.String(), Type.Unknown()),
  ]),
  encrypted: true,
  redacted: true,
};

/** Matches `api_key_<provider>` where provider is a non-empty lowercase slug. */
const API_KEY_PATTERN = /^api_key_[a-z][a-z0-9-]*$/;

/** Matches `oauth_<provider>` where provider is a non-empty lowercase slug. */
const OAUTH_PATTERN = /^oauth_[a-z][a-z0-9-]*$/;

export type SettingsKey = keyof typeof SETTINGS_SCHEMA | `api_key_${string}` | `oauth_${string}`;

/** The shape of stored OAuth credentials. */
export type OAuthCredentialValue = {
  refresh: string;
  access: string;
  expires: number;
  [key: string]: unknown;
};

/** Infer the TypeScript type for a setting key. */
export type SettingValue<K extends SettingsKey> =
  K extends keyof typeof SETTINGS_SCHEMA
    ? Static<(typeof SETTINGS_SCHEMA)[K]["schema"]>
    : K extends `oauth_${string}`
      ? OAuthCredentialValue
      : string; // api_key_* keys are always strings

const REDACTED_PLACEHOLDER = "********";

// ---- Helpers ---------------------------------------------------------------

function isStaticSettingsKey(key: string): key is keyof typeof SETTINGS_SCHEMA {
  return key in SETTINGS_SCHEMA;
}

function isSettingsKey(key: string): key is SettingsKey {
  return isStaticSettingsKey(key) || API_KEY_PATTERN.test(key) || OAUTH_PATTERN.test(key);
}

function getDef(key: string): SettingDef {
  if (isStaticSettingsKey(key)) {
    return SETTINGS_SCHEMA[key];
  }
  if (API_KEY_PATTERN.test(key)) {
    return API_KEY_DEF;
  }
  if (OAUTH_PATTERN.test(key)) {
    return OAUTH_DEF;
  }
  throw new Error(`Unknown setting key: ${key}`);
}

function serializeValue(value: unknown, def: SettingDef): string {
  // Strings are stored as-is; objects are JSON-serialized
  if (def.schema.type === "string") {
    return String(value);
  }
  return JSON.stringify(value);
}

function deserializeValue(raw: string, def: SettingDef): unknown {
  if (def.schema.type === "string") {
    return raw;
  }
  return JSON.parse(raw);
}

// ---- Public API ------------------------------------------------------------

/**
 * Get a single setting value, or null if not set.
 * Decrypts encrypted settings automatically.
 */
export function getSetting<K extends SettingsKey>(
  key: K,
): SettingValue<K> | null {
  const def = getDef(key);
  const db = getDb();

  const row = db
    .query<{ value: string }, [string]>(
      "SELECT value FROM settings WHERE key = ?",
    )
    .get(key);

  if (!row) return null;

  let raw = row.value;
  if (def.encrypted) {
    raw = decrypt(raw);
  }

  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- schema-validated dynamic deserialize
  return deserializeValue(raw, def) as SettingValue<K>;
}

/**
 * Set a setting value. Validates against the schema, encrypts if needed,
 * and upserts into the DB.
 */
export function setSetting<K extends SettingsKey>(
  key: K,
  value: SettingValue<K>,
): void {
  const def = getDef(key);

  // Validate against schema
  if (!Value.Check(def.schema, value)) {
    const errors = [...Value.Errors(def.schema, value)];
    const messages = errors.map((e) => `${e.path}: ${e.message}`).join("; ");
    throw new Error(`Invalid value for setting "${key}": ${messages}`);
  }

  let serialized = serializeValue(value, def);
  if (def.encrypted) {
    serialized = encrypt(serialized);
  }

  const db = getDb();
  db.query(
    `INSERT INTO settings (key, value, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, serialized);
}

/**
 * Delete a setting from the DB.
 */
export function deleteSetting(key: SettingsKey): void {
  getDef(key); // validate key exists in schema
  const db = getDb();
  db.query("DELETE FROM settings WHERE key = ?").run(key);
}

/** A single entry returned by listSettings. */
export interface SettingEntry {
  key: SettingsKey;
  value: unknown;
  redacted: boolean;
}

/**
 * List all stored settings. Redacted settings have their values replaced
 * with a placeholder. Non-redacted settings are fully deserialized.
 */
export function listSettings(): SettingEntry[] {
  const db = getDb();
  const rows = db
    .query<{ key: string; value: string }, []>(
      "SELECT key, value FROM settings ORDER BY key",
    )
    .all();

  const entries: SettingEntry[] = [];
  for (const row of rows) {
    // Skip unknown keys (e.g. from a newer version)
    if (!isSettingsKey(row.key)) continue;

    const def = getDef(row.key);
    const isRedacted = def.redacted === true;

    let value: unknown;
    if (isRedacted) {
      value = REDACTED_PLACEHOLDER;
    } else {
      let raw = row.value;
      if (def.encrypted) {
        raw = decrypt(raw);
      }
      value = deserializeValue(raw, def);
    }

    entries.push({
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- validated by isSettingsKey guard above
      key: row.key as SettingsKey,
      value,
      redacted: isRedacted,
    });
  }

  return entries;
}

/**
 * Get the static setting keys from the schema (does not include dynamic api_key_* keys).
 */
export function getSettingsKeys(): SettingsKey[] {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Object.keys loses const narrowing
  return Object.keys(SETTINGS_SCHEMA) as SettingsKey[];
}

/**
 * Check whether a key is a valid settings key.
 * Accepts both static schema keys and dynamic `api_key_*` keys.
 */
export function isValidSettingsKey(key: string): key is SettingsKey {
  return isSettingsKey(key);
}

/**
 * Check whether a setting key has the redacted flag.
 */
export function isRedactedKey(key: SettingsKey): boolean {
  const def = getDef(key);
  return def.redacted === true;
}

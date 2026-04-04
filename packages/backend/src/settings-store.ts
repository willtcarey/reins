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
  api_key_anthropic: {
    schema: Type.String(),
    encrypted: true,
    redacted: true,
  },
  api_key_openai: {
    schema: Type.String(),
    encrypted: true,
    redacted: true,
  },
  api_key_openrouter: {
    schema: Type.String(),
    encrypted: true,
    redacted: true,
  },
} as const satisfies Record<string, SettingDef>;

export type SettingsKey = keyof typeof SETTINGS_SCHEMA;

/** Infer the TypeScript type for a setting key. */
export type SettingValue<K extends SettingsKey> = Static<
  (typeof SETTINGS_SCHEMA)[K]["schema"]
>;

const REDACTED_PLACEHOLDER = "********";

// ---- Helpers ---------------------------------------------------------------

function isSettingsKey(key: string): key is SettingsKey {
  return key in SETTINGS_SCHEMA;
}

function getDef(key: string): SettingDef {
  if (!isSettingsKey(key)) {
    throw new Error(`Unknown setting key: ${key}`);
  }
  return SETTINGS_SCHEMA[key];
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
  secret: Buffer,
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
    raw = decrypt(raw, secret);
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
  secret: Buffer,
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
    serialized = encrypt(serialized, secret);
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
export function listSettings(secret: Buffer): SettingEntry[] {
  const db = getDb();
  const rows = db
    .query<{ key: string; value: string }, []>(
      "SELECT key, value FROM settings ORDER BY key",
    )
    .all();

  const entries: SettingEntry[] = [];
  for (const row of rows) {
    // Skip unknown keys (e.g. from a newer version)
    if (!(row.key in SETTINGS_SCHEMA)) continue;

    const def = getDef(row.key);
    const isRedacted = def.redacted === true;

    let value: unknown;
    if (isRedacted) {
      value = REDACTED_PLACEHOLDER;
    } else {
      let raw = row.value;
      if (def.encrypted) {
        raw = decrypt(raw, secret);
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
 * Get all valid setting keys from the schema.
 */
export function getSettingsKeys(): SettingsKey[] {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Object.keys loses const narrowing
  return Object.keys(SETTINGS_SCHEMA) as SettingsKey[];
}

/**
 * Check whether a key is a valid settings key.
 */
export function isValidSettingsKey(key: string): key is SettingsKey {
  return key in SETTINGS_SCHEMA;
}

/**
 * Check whether a setting key has the redacted flag.
 */
export function isRedactedKey(key: SettingsKey): boolean {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- accessing optional flag from union
  const def = SETTINGS_SCHEMA[key] as SettingDef;
  return def.redacted === true;
}

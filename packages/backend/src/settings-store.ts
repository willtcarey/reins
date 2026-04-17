import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { getDb } from "./db.js";

// Keep this local to avoid a circular dependency with models/model-settings.ts,
// which resolves persisted settings by calling back into this store.
const MODEL_SETTING_THINKING_LEVEL_VALUES = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

const ModelSettingThinkingLevelSchema = Type.Union(
  MODEL_SETTING_THINKING_LEVEL_VALUES.map((level) => Type.Literal(level)),
  { description: `Thinking level (${MODEL_SETTING_THINKING_LEVEL_VALUES.join(", ")})` },
);

export const ModelSettingSchema = Type.Object({
  provider: Type.String(),
  modelId: Type.String(),
  runtimeType: Type.String(),
  thinkingLevel: ModelSettingThinkingLevelSchema,
});

export const SETTINGS_SCHEMA = {
  default_model: ModelSettingSchema,
  utility_model: ModelSettingSchema,
} as const;

type SettingsSchema = typeof SETTINGS_SCHEMA;
type KeysMatchingSchema<TTarget extends TSchema> = {
  [K in SettingsKey]: [SettingValue<K>] extends [Static<TTarget>]
    ? [Static<TTarget>] extends [SettingValue<K>] ? K : never
    : never;
}[SettingsKey];

export type SettingsKey = keyof SettingsSchema;
export type SettingValue<K extends SettingsKey> = Static<SettingsSchema[K]>;
export type ModelSetting = Static<typeof ModelSettingSchema>;
export type ModelSettingsKey = KeysMatchingSchema<typeof ModelSettingSchema>;

export interface SettingEntry<K extends SettingsKey = SettingsKey> {
  key: K;
  value: SettingValue<K>;
}

function getSchema<K extends SettingsKey>(key: K): SettingsSchema[K] {
  return SETTINGS_SCHEMA[key];
}

function formatSchemaErrors(schema: TSchema, value: unknown): string {
  return [...Value.Errors(schema, value)]
    .map((error) => `${error.path}: ${error.message}`)
    .join("; ");
}

function buildValidationError<K extends SettingsKey>(
  messagePrefix: string,
  key: K,
  value: unknown,
): Error {
  return new Error(`${messagePrefix} "${key}": ${formatSchemaErrors(getSchema(key), value)}`);
}

function matchesSettingValue<K extends SettingsKey>(key: K, value: unknown): value is SettingValue<K> {
  return Value.Check(getSchema(key), value);
}

export function validateSettingValue<K extends SettingsKey>(key: K, value: unknown): SettingValue<K> {
  if (!matchesSettingValue(key, value)) {
    throw buildValidationError("Invalid value for setting", key, value);
  }

  return value;
}

function parseStoredValue<K extends SettingsKey>(key: K, raw: string): SettingValue<K> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`Stored value for setting "${key}" is not valid JSON`);
  }

  if (!matchesSettingValue(key, value)) {
    throw new Error(`Stored value for setting "${key}" is invalid: ${formatSchemaErrors(getSchema(key), value)}`);
  }

  return value;
}

function serializeValue<K extends SettingsKey>(key: K, value: SettingValue<K>): string {
  return JSON.stringify(validateSettingValue(key, value));
}

export function getSetting<K extends SettingsKey>(key: K): SettingValue<K> | null {
  const row = getDb()
    .query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?")
    .get(key);

  return row ? parseStoredValue(key, row.value) : null;
}

export function setSetting<K extends SettingsKey>(key: K, value: SettingValue<K>): void {
  getDb().query(
    `INSERT INTO settings (key, value, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, serializeValue(key, value));
}

export function deleteSetting(key: SettingsKey): void {
  getDb().query("DELETE FROM settings WHERE key = ?").run(key);
}

function listAllSettings(): SettingEntry[] {
  const rows = getDb()
    .query<{ key: SettingsKey; value: string }, []>(
      "SELECT key, value FROM settings ORDER BY key",
    )
    .all();

  return rows.map((row) => ({
    key: row.key,
    value: parseStoredValue(row.key, row.value),
  }));
}

function listSettingsForKeys<K extends SettingsKey>(keys: readonly K[]): SettingEntry<K>[] {
  if (keys.length === 0) {
    return [];
  }

  const rows = getDb()
    .query<{ key: K; value: string }, string[]>(
      `SELECT key, value
       FROM settings
       WHERE key IN (${keys.map(() => "?").join(", ")})
       ORDER BY key`,
    )
    .all(...keys);

  return rows.map((row) => ({
    key: row.key,
    value: parseStoredValue(row.key, row.value),
  }));
}

export function listSettings(): SettingEntry[];
export function listSettings<K extends SettingsKey>(keys: readonly K[]): SettingEntry<K>[];
export function listSettings<K extends SettingsKey>(keys?: readonly K[]) {
  return keys ? listSettingsForKeys(keys) : listAllSettings();
}

export function isValidSettingsKey(key: string): key is SettingsKey {
  return Object.prototype.hasOwnProperty.call(SETTINGS_SCHEMA, key);
}

const SETTINGS_KEYS: SettingsKey[] = [];
for (const key in SETTINGS_SCHEMA) {
  if (isValidSettingsKey(key)) {
    SETTINGS_KEYS.push(key);
  }
}

export function getSettingsKeys(): SettingsKey[] {
  return [...SETTINGS_KEYS];
}

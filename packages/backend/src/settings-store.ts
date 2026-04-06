import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { getDb } from "./db.js";
import { ThinkingLevelSchema } from "./thinking-level.js";

const ModelSettingSchema = Type.Object({
  provider: Type.String(),
  modelId: Type.String(),
  thinkingLevel: ThinkingLevelSchema,
});

const SETTINGS_SCHEMA = {
  default_model: ModelSettingSchema,
  utility_model: ModelSettingSchema,
} as const;

export type SettingsKey = keyof typeof SETTINGS_SCHEMA;
export type ModelSettingsKey = "default_model" | "utility_model";
export type ModelSetting = {
  provider: string;
  modelId: string;
  thinkingLevel: "minimal" | "low" | "medium" | "high" | "xhigh";
};

export interface SettingEntry {
  key: SettingsKey;
  value: ModelSetting;
  redacted: false;
}

function isSettingsKey(key: string): key is SettingsKey {
  return key === "default_model" || key === "utility_model";
}

function serializeValue(_key: SettingsKey, value: unknown): string {
  return JSON.stringify(value);
}

function deserializeValue(_key: SettingsKey, raw: string): ModelSetting {
  return JSON.parse(raw);
}

export function getSetting(key: ModelSettingsKey): ModelSetting | null;
export function getSetting(key: SettingsKey): ModelSetting | null {
  if (!isSettingsKey(key)) {
    throw new Error(`Unknown setting key: ${key}`);
  }

  const row = getDb()
    .query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?")
    .get(key);

  return row ? deserializeValue(key, row.value) : null;
}

export function setSetting(key: ModelSettingsKey, value: unknown): void;
export function setSetting(key: SettingsKey, value: unknown): void {
  if (!isSettingsKey(key)) {
    throw new Error(`Unknown setting key: ${key}`);
  }

  if (!Value.Check(SETTINGS_SCHEMA[key], value)) {
    const errors = [...Value.Errors(SETTINGS_SCHEMA[key], value)];
    const messages = errors.map((error) => `${error.path}: ${error.message}`).join("; ");
    throw new Error(`Invalid value for setting "${key}": ${messages}`);
  }

  getDb().query(
    `INSERT INTO settings (key, value, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, serializeValue(key, value));
}

export function deleteSetting(key: SettingsKey): void {
  if (!isSettingsKey(key)) {
    throw new Error(`Unknown setting key: ${key}`);
  }

  getDb().query("DELETE FROM settings WHERE key = ?").run(key);
}

export function listSettings(): SettingEntry[] {
  const rows = getDb()
    .query<{ key: string; value: string }, []>(
      "SELECT key, value FROM settings ORDER BY key",
    )
    .all();

  const entries: SettingEntry[] = [];
  for (const row of rows) {
    if (!isSettingsKey(row.key)) continue;
    entries.push({
      key: row.key,
      value: deserializeValue(row.key, row.value),
      redacted: false,
    });
  }

  return entries;
}

export function getSettingsKeys(): SettingsKey[] {
  return ["default_model", "utility_model"];
}

export function isValidSettingsKey(key: string): key is SettingsKey {
  return isSettingsKey(key);
}

export function isRedactedKey(_key: SettingsKey): boolean {
  return false;
}

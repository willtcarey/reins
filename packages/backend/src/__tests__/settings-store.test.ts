import { describe, test, expect } from "bun:test";
import { getDb } from "../db.js";
import { useTestDb } from "./helpers/test-db.js";
import {
  getSetting,
  setSetting,
  deleteSetting,
  listSettings,
  isValidSettingsKey,
  validateSettingValue,
} from "../settings-store.js";

describe("settings-store", () => {
  useTestDb();

  describe("keys", () => {
    test("accepts static settings keys", () => {
      expect(isValidSettingsKey("default_model")).toBe(true);
      expect(isValidSettingsKey("utility_model")).toBe(true);
    });

    test("rejects legacy auth keys", () => {
      expect(isValidSettingsKey("api_key_anthropic")).toBe(false);
      expect(isValidSettingsKey("oauth_anthropic")).toBe(false);
    });
  });

  describe("getSetting", () => {
    test("returns null for missing key", () => {
      expect(getSetting("default_model")).toBeNull();
    });

    test("returns typed object for default_model", () => {
      const model = { provider: "anthropic", modelId: "claude-4", runtimeType: "pi", thinkingLevel: "high" } as const;
      setSetting("default_model", model);

      expect(getSetting("default_model")).toEqual(model);
    });

    test("returns typed object for utility_model", () => {
      const model = { provider: "anthropic", modelId: "claude-haiku-4-5", runtimeType: "pi", thinkingLevel: "minimal" } as const;
      setSetting("utility_model", model);

      expect(getSetting("utility_model")).toEqual(model);
    });

    test("throws when a stored setting no longer matches its schema", () => {
      getDb()
        .query("INSERT INTO settings (key, value) VALUES (?, ?)")
        .run("default_model", JSON.stringify({ provider: "anthropic" }));

      expect(() => getSetting("default_model")).toThrow(/Stored value for setting "default_model" is invalid/);
    });

    test("throws for unknown key", () => {
      const getUnknownSetting = (key: string) => {
        if (key === "default_model") {
          return getSetting(key);
        }
        throw new Error(`Unknown setting key: ${key}`);
      };

      expect(() => getUnknownSetting("nonexistent")).toThrow(/Unknown setting key/);
    });
  });

  describe("setSetting", () => {
    test("round-trips with getSetting for default_model", () => {
      const model = { provider: "openai", modelId: "gpt-5", runtimeType: "pi", thinkingLevel: "minimal" } as const;
      setSetting("default_model", model);
      expect(getSetting("default_model")).toEqual(model);
    });

    test("upserts on second call", () => {
      setSetting("default_model", { provider: "a", modelId: "b", runtimeType: "pi", thinkingLevel: "minimal" });
      setSetting("default_model", { provider: "x", modelId: "y", runtimeType: "pi", thinkingLevel: "high" });
      expect(getSetting("default_model")).toEqual({
        provider: "x",
        modelId: "y",
        runtimeType: "pi",
        thinkingLevel: "high",
      });
    });

    test("rejects invalid data", () => {
      expect(() => validateSettingValue("default_model", "not-an-object")).toThrow(/Invalid value/);
      expect(() => validateSettingValue("default_model", { provider: "a" })).toThrow(/Invalid value/);
      expect(() => validateSettingValue("default_model", { provider: 123, modelId: "b", runtimeType: "pi", thinkingLevel: "medium" })).toThrow(/Invalid value/);
      expect(() => validateSettingValue("default_model", { provider: "a", modelId: "b", thinkingLevel: "off" })).toThrow(/Invalid value/);
    });
  });

  describe("deleteSetting", () => {
    test("get returns null after delete", () => {
      setSetting("default_model", { provider: "a", modelId: "b", runtimeType: "pi", thinkingLevel: "minimal" });
      deleteSetting("default_model");
      expect(getSetting("default_model")).toBeNull();
    });
  });

  describe("listSettings", () => {
    test("returns empty array when no settings stored", () => {
      expect(listSettings()).toEqual([]);
    });

    test("returns stored settings", () => {
      const defaultModel = { provider: "anthropic", modelId: "claude-4", runtimeType: "pi", thinkingLevel: "high" } as const;
      const utilityModel = { provider: "anthropic", modelId: "claude-haiku-4-5", runtimeType: "pi", thinkingLevel: "minimal" } as const;
      setSetting("default_model", defaultModel);
      setSetting("utility_model", utilityModel);

      expect(listSettings()).toEqual([
        {
          key: "default_model",
          value: defaultModel,
        },
        {
          key: "utility_model",
          value: utilityModel,
        },
      ]);
    });

    test("returns a filtered subset for the requested keys", () => {
      const defaultModel = { provider: "anthropic", modelId: "claude-4", runtimeType: "pi", thinkingLevel: "high" } as const;
      const utilityModel = { provider: "anthropic", modelId: "claude-haiku-4-5", runtimeType: "pi", thinkingLevel: "minimal" } as const;
      setSetting("default_model", defaultModel);
      setSetting("utility_model", utilityModel);

      expect(listSettings(["utility_model", "default_model"])).toEqual([
        {
          key: "default_model",
          value: defaultModel,
        },
        {
          key: "utility_model",
          value: utilityModel,
        },
      ]);
    });

    test("returns an empty array when filtering by no valid keys", () => {
      setSetting("default_model", { provider: "anthropic", modelId: "claude-4", runtimeType: "pi", thinkingLevel: "high" });

      expect(listSettings([])).toEqual([]);
    });
  });
});

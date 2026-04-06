import { describe, test, expect } from "bun:test";
import { useTestDb } from "./helpers/test-db.js";
import {
  getSetting,
  setSetting,
  deleteSetting,
  listSettings,
  isValidSettingsKey,
} from "../settings-store.js";

describe("settings-store", () => {
  useTestDb();

  describe("keys", () => {
    test("accepts static settings keys", () => {
      expect(isValidSettingsKey("default_model")).toBe(true);
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
      const model = { provider: "anthropic", modelId: "claude-4", thinkingLevel: "high" } as const;
      setSetting("default_model", model);

      expect(getSetting("default_model")).toEqual(model);
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
      const model = { provider: "openai", modelId: "gpt-5", thinkingLevel: "minimal" } as const;
      setSetting("default_model", model);
      expect(getSetting("default_model")).toEqual(model);
    });

    test("upserts on second call", () => {
      setSetting("default_model", { provider: "a", modelId: "b", thinkingLevel: "minimal" });
      setSetting("default_model", { provider: "x", modelId: "y", thinkingLevel: "high" });
      expect(getSetting("default_model")).toEqual({
        provider: "x",
        modelId: "y",
        thinkingLevel: "high",
      });
    });

    test("rejects invalid data", () => {
      expect(() => setSetting("default_model", "not-an-object")).toThrow(/Invalid value/);
      expect(() => setSetting("default_model", { provider: "a" })).toThrow(/Invalid value/);
      expect(() => setSetting("default_model", { provider: 123, modelId: "b", thinkingLevel: "medium" })).toThrow(/Invalid value/);
      expect(() => setSetting("default_model", { provider: "a", modelId: "b", thinkingLevel: "off" })).toThrow(/Invalid value/);
    });
  });

  describe("deleteSetting", () => {
    test("get returns null after delete", () => {
      setSetting("default_model", { provider: "a", modelId: "b", thinkingLevel: "minimal" });
      deleteSetting("default_model");
      expect(getSetting("default_model")).toBeNull();
    });
  });

  describe("listSettings", () => {
    test("returns empty array when no settings stored", () => {
      expect(listSettings()).toEqual([]);
    });

    test("returns stored settings", () => {
      const model = { provider: "anthropic", modelId: "claude-4", thinkingLevel: "high" } as const;
      setSetting("default_model", model);

      expect(listSettings()).toEqual([
        {
          key: "default_model",
          value: model,
          redacted: false,
        },
      ]);
    });
  });
});

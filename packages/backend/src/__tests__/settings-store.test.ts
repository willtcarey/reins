import { describe, test, expect } from "bun:test";
import { randomBytes } from "crypto";
import { initEncryptionSecret } from "../crypto.js";
import { useTestDb } from "./helpers/test-db.js";
import { getDb } from "../db.js";
import {
  getSetting,
  setSetting,
  deleteSetting,
  listSettings,
} from "../settings-store.js";

// Initialize encryption secret for tests
initEncryptionSecret(randomBytes(32));

describe("settings-store", () => {
  useTestDb();

  // ---- getSetting ----------------------------------------------------------

  describe("getSetting", () => {
    test("returns null for missing key", () => {
      expect(getSetting("default_model")).toBeNull();
    });

    test("returns typed object for default_model", () => {
      const model = { provider: "anthropic", modelId: "claude-4", thinkingLevel: "high" } as const;
      setSetting("default_model", model);

      const result = getSetting("default_model");
      expect(result).toEqual(model);
    });

    test("returns decrypted string for api_key_anthropic", () => {
      const key = "sk-ant-test-key-12345";
      setSetting("api_key_anthropic", key);

      const result = getSetting("api_key_anthropic");
      expect(result).toBe(key);
    });

    test("throws for unknown key", () => {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- testing runtime validation of bad input
      expect(() => getSetting("nonexistent" as any)).toThrow(
        /Unknown setting key/,
      );
    });
  });

  // ---- setSetting ----------------------------------------------------------

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

    test("rejects invalid data — wrong type", () => {
      const badValue: unknown = "not-an-object";
      // @ts-expect-error -- testing runtime validation of bad input
      expect(() => setSetting("default_model", badValue)).toThrow(/Invalid value/);
    });

    test("rejects invalid data — missing fields", () => {
      const badValue: unknown = { provider: "a" };
      // @ts-expect-error -- testing runtime validation of bad input
      expect(() => setSetting("default_model", badValue)).toThrow(/Invalid value/);
    });

    test("rejects invalid data — wrong field type", () => {
      const badValue: unknown = { provider: 123, modelId: "b", thinkingLevel: "medium" };
      // @ts-expect-error -- testing runtime validation of bad input
      expect(() => setSetting("default_model", badValue)).toThrow(/Invalid value/);
    });

    test("rejects invalid data — invalid thinking level", () => {
      const badValue: unknown = { provider: "a", modelId: "b", thinkingLevel: "off" };
      // @ts-expect-error -- testing runtime validation of bad input
      expect(() => setSetting("default_model", badValue)).toThrow(/Invalid value/);
    });

    test("encrypted values are not plaintext in DB", () => {
      const apiKey = "sk-ant-super-secret-key";
      setSetting("api_key_anthropic", apiKey);

      const db = getDb();
      const row = db
        .query<{ value: string }, [string]>(
          "SELECT value FROM settings WHERE key = ?",
        )
        .get("api_key_anthropic");

      expect(row).not.toBeNull();
      expect(row!.value).not.toBe(apiKey);
      expect(row!.value).not.toContain("super-secret");
    });

    test("non-encrypted values are stored as plaintext JSON", () => {
      const model = { provider: "anthropic", modelId: "claude-4", thinkingLevel: "high" } as const;
      setSetting("default_model", model);

      const db = getDb();
      const row = db
        .query<{ value: string }, [string]>(
          "SELECT value FROM settings WHERE key = ?",
        )
        .get("default_model");

      expect(row).not.toBeNull();
      expect(JSON.parse(row!.value)).toEqual(model);
    });
  });

  // ---- deleteSetting -------------------------------------------------------

  describe("deleteSetting", () => {
    test("get returns null after delete", () => {
      setSetting("default_model", { provider: "a", modelId: "b", thinkingLevel: "minimal" });
      expect(getSetting("default_model")).not.toBeNull();

      deleteSetting("default_model");
      expect(getSetting("default_model")).toBeNull();
    });

    test("delete on non-existent key is a no-op", () => {
      expect(() => deleteSetting("default_model")).not.toThrow();
    });

    test("throws for unknown key", () => {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- testing runtime validation of bad input
      expect(() => deleteSetting("nonexistent" as any)).toThrow(
        /Unknown setting key/,
      );
    });
  });

  // ---- listSettings --------------------------------------------------------

  describe("listSettings", () => {
    test("returns empty array when no settings stored", () => {
      expect(listSettings()).toEqual([]);
    });

    test("API keys show as redacted", () => {
      setSetting("api_key_anthropic", "sk-ant-key");
      setSetting("api_key_openai", "sk-openai-key");

      const entries = listSettings();
      const anthropic = entries.find((e) => e.key === "api_key_anthropic");
      const openai = entries.find((e) => e.key === "api_key_openai");

      expect(anthropic).toBeDefined();
      expect(anthropic!.value).toBe("********");
      expect(anthropic!.redacted).toBe(true);

      expect(openai).toBeDefined();
      expect(openai!.value).toBe("********");
      expect(openai!.redacted).toBe(true);
    });

    test("non-redacted values shown normally", () => {
      const model = { provider: "anthropic", modelId: "claude-4", thinkingLevel: "high" } as const;
      setSetting("default_model", model);

      const entries = listSettings();
      const entry = entries.find((e) => e.key === "default_model");

      expect(entry).toBeDefined();
      expect(entry!.value).toEqual(model);
      expect(entry!.redacted).toBe(false);
    });

    test("returns all stored settings sorted by key", () => {
      setSetting("default_model", { provider: "a", modelId: "b", thinkingLevel: "minimal" });
      setSetting("api_key_anthropic", "key1");
      setSetting("api_key_openai", "key2");

      const entries = listSettings();
      expect(entries).toHaveLength(3);
      // Sorted by key
      expect(entries.map((e) => e.key)).toEqual([
        "api_key_anthropic",
        "api_key_openai",
        "default_model",
      ]);
    });
  });
});

import { describe, test, expect } from "bun:test";
import { randomBytes } from "crypto";
import { useTestDb } from "./helpers/test-db.js";
import { getDb } from "../db.js";
import {
  getSetting,
  setSetting,
  deleteSetting,
  listSettings,
} from "../settings-store.js";

describe("settings-store", () => {
  useTestDb();

  const secret = randomBytes(32);

  // ---- getSetting ----------------------------------------------------------

  describe("getSetting", () => {
    test("returns null for missing key", () => {
      expect(getSetting("default_model", secret)).toBeNull();
    });

    test("returns typed object for default_model", () => {
      const model = { provider: "anthropic", modelId: "claude-4", thinkingLevel: "high" };
      setSetting("default_model", model, secret);

      const result = getSetting("default_model", secret);
      expect(result).toEqual(model);
    });

    test("returns decrypted string for api_key_anthropic", () => {
      const key = "sk-ant-test-key-12345";
      setSetting("api_key_anthropic", key, secret);

      const result = getSetting("api_key_anthropic", secret);
      expect(result).toBe(key);
    });

    test("throws for unknown key", () => {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- testing runtime validation of bad input
      expect(() => getSetting("nonexistent" as any, secret)).toThrow(
        /Unknown setting key/,
      );
    });
  });

  // ---- setSetting ----------------------------------------------------------

  describe("setSetting", () => {
    test("round-trips with getSetting for default_model", () => {
      const model = { provider: "openai", modelId: "gpt-5", thinkingLevel: "off" };
      setSetting("default_model", model, secret);
      expect(getSetting("default_model", secret)).toEqual(model);
    });

    test("upserts on second call", () => {
      setSetting("default_model", { provider: "a", modelId: "b", thinkingLevel: "off" }, secret);
      setSetting("default_model", { provider: "x", modelId: "y", thinkingLevel: "high" }, secret);
      expect(getSetting("default_model", secret)).toEqual({
        provider: "x",
        modelId: "y",
        thinkingLevel: "high",
      });
    });

    test("rejects invalid data — wrong type", () => {
      const badValue: unknown = "not-an-object";
      // @ts-expect-error -- testing runtime validation of bad input
      expect(() => setSetting("default_model", badValue, secret)).toThrow(/Invalid value/);
    });

    test("rejects invalid data — missing fields", () => {
      const badValue: unknown = { provider: "a" };
      // @ts-expect-error -- testing runtime validation of bad input
      expect(() => setSetting("default_model", badValue, secret)).toThrow(/Invalid value/);
    });

    test("rejects invalid data — wrong field type", () => {
      const badValue: unknown = { provider: 123, modelId: "b", thinkingLevel: "off" };
      // @ts-expect-error -- testing runtime validation of bad input
      expect(() => setSetting("default_model", badValue, secret)).toThrow(/Invalid value/);
    });

    test("encrypted values are not plaintext in DB", () => {
      const apiKey = "sk-ant-super-secret-key";
      setSetting("api_key_anthropic", apiKey, secret);

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
      const model = { provider: "anthropic", modelId: "claude-4", thinkingLevel: "high" };
      setSetting("default_model", model, secret);

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
      setSetting("default_model", { provider: "a", modelId: "b", thinkingLevel: "off" }, secret);
      expect(getSetting("default_model", secret)).not.toBeNull();

      deleteSetting("default_model");
      expect(getSetting("default_model", secret)).toBeNull();
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
      expect(listSettings(secret)).toEqual([]);
    });

    test("API keys show as redacted", () => {
      setSetting("api_key_anthropic", "sk-ant-key", secret);
      setSetting("api_key_openai", "sk-openai-key", secret);

      const entries = listSettings(secret);
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
      const model = { provider: "anthropic", modelId: "claude-4", thinkingLevel: "high" };
      setSetting("default_model", model, secret);

      const entries = listSettings(secret);
      const entry = entries.find((e) => e.key === "default_model");

      expect(entry).toBeDefined();
      expect(entry!.value).toEqual(model);
      expect(entry!.redacted).toBe(false);
    });

    test("returns all stored settings sorted by key", () => {
      setSetting("default_model", { provider: "a", modelId: "b", thinkingLevel: "off" }, secret);
      setSetting("api_key_anthropic", "key1", secret);
      setSetting("api_key_openai", "key2", secret);

      const entries = listSettings(secret);
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

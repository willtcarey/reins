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
  isValidSettingsKey,
} from "../settings-store.js";

// Initialize encryption secret for tests
initEncryptionSecret(randomBytes(32));

describe("settings-store oauth_* keys", () => {
  useTestDb();

  const validCreds = {
    refresh: "refresh-token-123",
    access: "access-token-456",
    expires: Date.now() + 3600_000,
  };

  const credsWithExtras = {
    ...validCreds,
    scope: "read write",
    tokenType: "Bearer",
  };

  // ---- isValidSettingsKey --------------------------------------------------

  describe("isValidSettingsKey", () => {
    test("accepts oauth_<provider> keys", () => {
      expect(isValidSettingsKey("oauth_anthropic")).toBe(true);
      expect(isValidSettingsKey("oauth_github-copilot")).toBe(true);
      expect(isValidSettingsKey("oauth_google-gemini-cli")).toBe(true);
    });

    test("rejects malformed oauth keys", () => {
      expect(isValidSettingsKey("oauth_")).toBe(false);
      expect(isValidSettingsKey("oauth_123")).toBe(false);
      expect(isValidSettingsKey("oauth_")).toBe(false);
      expect(isValidSettingsKey("oauth")).toBe(false);
    });
  });

  // ---- setSetting + getSetting ---------------------------------------------

  describe("setSetting + getSetting", () => {
    test("round-trips basic OAuth credentials", () => {
      setSetting("oauth_anthropic", validCreds);
      const result = getSetting("oauth_anthropic");
      expect(result).toEqual(validCreds);
    });

    test("round-trips credentials with extra fields", () => {
      setSetting("oauth_github-copilot", credsWithExtras);
      const result = getSetting("oauth_github-copilot");
      expect(result).toEqual(credsWithExtras);
    });

    test("rejects credentials missing required fields", () => {
      const bad = { refresh: "token" }; // missing access and expires
      // @ts-expect-error -- testing runtime validation of bad input
      expect(() => setSetting("oauth_anthropic", bad)).toThrow(/Invalid value/);
    });

    test("rejects non-object value", () => {
      // @ts-expect-error -- testing runtime validation
      expect(() => setSetting("oauth_anthropic", "not-an-object")).toThrow(/Invalid value/);
    });

    test("encrypted values are not plaintext in DB", () => {
      setSetting("oauth_anthropic", validCreds);

      const db = getDb();
      const row = db
        .query<{ value: string }, [string]>(
          "SELECT value FROM settings WHERE key = ?",
        )
        .get("oauth_anthropic");

      expect(row).not.toBeNull();
      expect(row!.value).not.toContain("refresh-token-123");
      expect(row!.value).not.toContain("access-token-456");
    });
  });

  // ---- deleteSetting -------------------------------------------------------

  describe("deleteSetting", () => {
    test("removes stored OAuth credentials", () => {
      setSetting("oauth_anthropic", validCreds);
      expect(getSetting("oauth_anthropic")).not.toBeNull();

      deleteSetting("oauth_anthropic");
      expect(getSetting("oauth_anthropic")).toBeNull();
    });
  });

  // ---- listSettings --------------------------------------------------------

  describe("listSettings", () => {
    test("OAuth keys show as redacted", () => {
      setSetting("oauth_anthropic", validCreds);

      const entries = listSettings();
      const entry = entries.find((e) => e.key === "oauth_anthropic");

      expect(entry).toBeDefined();
      expect(entry!.value).toBe("********");
      expect(entry!.redacted).toBe(true);
    });
  });
});

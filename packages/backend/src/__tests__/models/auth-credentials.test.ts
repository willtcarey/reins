import { describe, expect, test } from "bun:test";
import { useTestDb } from "../helpers/test-db.js";
import {
  deleteApiKey,
  deleteOAuthCredential,
  listConfiguredApiKeyProviders,
  setApiKey,
  setOAuthCredentialValue,
} from "../../models/auth-credentials.js";
import {
  getAuthCredential,
  setApiKeyCredential,
  setOAuthCredential,
} from "../../auth-credentials-store.js";

describe("auth credentials model", () => {
  useTestDb();
  const sessions = new Map();

  test("lists only providers with configured API keys", () => {
    setApiKeyCredential("anthropic", "sk-ant");
    setOAuthCredential("openai", {
      refresh: "refresh-openai",
      access: "access-openai",
      expires: Date.now() + 60_000,
    });

    expect(listConfiguredApiKeyProviders()).toEqual(["anthropic"]);
  });

  test("stores and deletes API keys without removing OAuth credentials", () => {
    setOAuthCredential("anthropic", {
      refresh: "refresh-ant",
      access: "access-ant",
      expires: Date.now() + 60_000,
    });

    setApiKey("anthropic", "sk-updated", sessions);
    expect(getAuthCredential("anthropic", "api_key")?.value).toBe("sk-updated");

    deleteApiKey("anthropic", sessions);
    expect(getAuthCredential("anthropic", "api_key")).toBeNull();
    expect(getAuthCredential("anthropic", "oauth")?.value).toEqual({
      refresh: "refresh-ant",
      access: "access-ant",
      expires: expect.any(Number),
    });
  });

  test("stores and removes OAuth credentials", () => {
    setOAuthCredentialValue("test-oauth", {
      refresh: "refresh-code",
      access: "access-code",
      expires: Date.now() + 60_000,
    }, sessions);

    expect(getAuthCredential("test-oauth", "oauth")?.value).toEqual({
      refresh: "refresh-code",
      access: "access-code",
      expires: expect.any(Number),
    });

    deleteOAuthCredential("test-oauth", sessions);
    expect(getAuthCredential("test-oauth", "oauth")).toBeNull();
  });
});

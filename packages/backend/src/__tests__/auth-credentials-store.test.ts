import { describe, test, expect } from "bun:test";
import { randomBytes } from "crypto";
import { initEncryptionSecret } from "../crypto.js";
import { useTestDb } from "./helpers/test-db.js";
import { getDb } from "../db.js";
import {
  getAuthCredential,
  setApiKeyCredential,
  setOAuthCredential,
  deleteAuthCredential,
  listAuthCredentials,
  listAuthProviders,
} from "../auth-credentials-store.js";

initEncryptionSecret(randomBytes(32));

describe("auth-credentials-store", () => {
  useTestDb();

  test("stores and reads API key credentials", () => {
    setApiKeyCredential("anthropic", "sk-ant-test");

    expect(getAuthCredential("anthropic", "api_key")).toEqual({
      provider: "anthropic",
      type: "api_key",
      value: "sk-ant-test",
      updatedAt: expect.any(String),
    });
  });

  test("stores and reads OAuth credentials", () => {
    const value = {
      refresh: "refresh-token",
      access: "access-token",
      expires: Date.now() + 60_000,
      scope: "read",
    };

    setOAuthCredential("anthropic", value);

    expect(getAuthCredential("anthropic", "oauth")).toEqual({
      provider: "anthropic",
      type: "oauth",
      value,
      updatedAt: expect.any(String),
    });
  });

  test("allows API key and OAuth credentials to coexist for the same provider", () => {
    setApiKeyCredential("anthropic", "sk-ant-test");
    setOAuthCredential("anthropic", {
      refresh: "refresh-token",
      access: "access-token",
      expires: Date.now() + 60_000,
    });

    const credentials = listAuthCredentials();
    expect(credentials).toEqual([
      {
        provider: "anthropic",
        type: "api_key",
        value: "********",
        redacted: true,
        updatedAt: expect.any(String),
      },
      {
        provider: "anthropic",
        type: "oauth",
        value: "********",
        redacted: true,
        updatedAt: expect.any(String),
      },
    ]);
  });

  test("encrypts persisted values at rest", () => {
    setApiKeyCredential("anthropic", "sk-ant-super-secret");

    const row = getDb()
      .query<{ value: string }, [string, string]>(
        "SELECT value FROM auth_credentials WHERE provider = ? AND type = ?",
      )
      .get("anthropic", "api_key");

    expect(row).not.toBeNull();
    expect(row!.value).not.toContain("super-secret");
    expect(row!.value).not.toBe("sk-ant-super-secret");
  });

  test("deletes a single credential type without touching the other", () => {
    setApiKeyCredential("anthropic", "sk-ant-test");
    setOAuthCredential("anthropic", {
      refresh: "refresh-token",
      access: "access-token",
      expires: Date.now() + 60_000,
    });

    deleteAuthCredential("anthropic", "api_key");

    expect(getAuthCredential("anthropic", "api_key")).toBeNull();
    expect(getAuthCredential("anthropic", "oauth")).toEqual({
      provider: "anthropic",
      type: "oauth",
      value: {
        refresh: "refresh-token",
        access: "access-token",
        expires: expect.any(Number),
      },
      updatedAt: expect.any(String),
    });
  });

  test("lists configured providers once", () => {
    setApiKeyCredential("anthropic", "sk-ant-test");
    setOAuthCredential("openai", {
      refresh: "refresh-token",
      access: "access-token",
      expires: Date.now() + 60_000,
    });

    expect(listAuthProviders()).toEqual(["anthropic", "openai"]);
  });
});

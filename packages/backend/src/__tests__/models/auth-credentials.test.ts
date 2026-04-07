import { describe, test, expect, mock } from "bun:test";
import { useTestDb } from "../helpers/test-db.js";
import { createTestManagedSession } from "../helpers/test-pi.js";
import type { ManagedSession } from "../../state.js";
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

async function createMockManagedSession(sessionId: string): Promise<ManagedSession> {
  const managed = await createTestManagedSession(sessionId);
  managed.session.modelRegistry.authStorage.reload = mock<typeof managed.session.modelRegistry.authStorage.reload>(() => {});
  return managed;
}

describe("auth credentials model", () => {
  useTestDb();

  test("lists only providers with configured API keys", () => {
    setApiKeyCredential("anthropic", "sk-ant");
    setOAuthCredential("openai", {
      refresh: "refresh-openai",
      access: "access-openai",
      expires: Date.now() + 60_000,
    });

    expect(listConfiguredApiKeyProviders()).toEqual(["anthropic"]);
  });

  test("setApiKey stores the credential and reloads active session auth", async () => {
    const first = await createMockManagedSession("sess-1");
    const second = await createMockManagedSession("sess-2");
    const sessions = new Map<string, ManagedSession>([
      [first.id, first],
      [second.id, second],
    ]);

    setApiKey("anthropic", "sk-updated", sessions);

    expect(getAuthCredential("anthropic", "api_key")).toEqual({
      provider: "anthropic",
      type: "api_key",
      value: "sk-updated",
      updatedAt: expect.any(String),
    });
    expect(first.session.modelRegistry.authStorage.reload).toHaveBeenCalledTimes(1);
    expect(second.session.modelRegistry.authStorage.reload).toHaveBeenCalledTimes(1);
  });

  test("deleteApiKey removes only the API key, preserves OAuth, and reloads sessions", async () => {
    const managed = await createMockManagedSession("sess-1");
    const sessions = new Map<string, ManagedSession>([[managed.id, managed]]);

    setApiKeyCredential("anthropic", "sk-ant");
    setOAuthCredential("anthropic", {
      refresh: "refresh-ant",
      access: "access-ant",
      expires: Date.now() + 60_000,
    });

    deleteApiKey("anthropic", sessions);

    expect(getAuthCredential("anthropic", "api_key")).toBeNull();
    expect(getAuthCredential("anthropic", "oauth")).toEqual({
      provider: "anthropic",
      type: "oauth",
      value: {
        refresh: "refresh-ant",
        access: "access-ant",
        expires: expect.any(Number),
      },
      updatedAt: expect.any(String),
    });
    expect(managed.session.modelRegistry.authStorage.reload).toHaveBeenCalledTimes(1);
  });

  test("OAuth mutations store/remove credentials and reload session auth", async () => {
    const managed = await createMockManagedSession("sess-1");
    const sessions = new Map<string, ManagedSession>([[managed.id, managed]]);

    setOAuthCredentialValue("test-oauth", {
      refresh: "refresh-code",
      access: "access-code",
      expires: Date.now() + 60_000,
    }, sessions);

    expect(getAuthCredential("test-oauth", "oauth")).toEqual({
      provider: "test-oauth",
      type: "oauth",
      value: {
        refresh: "refresh-code",
        access: "access-code",
        expires: expect.any(Number),
      },
      updatedAt: expect.any(String),
    });

    deleteOAuthCredential("test-oauth", sessions);

    expect(getAuthCredential("test-oauth", "oauth")).toBeNull();
    expect(managed.session.modelRegistry.authStorage.reload).toHaveBeenCalledTimes(2);
  });
});

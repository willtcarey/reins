import { describe, test, expect, mock } from "bun:test";
import { useTestDb } from "../helpers/test-db.js";
import { createTestManagedSession } from "../helpers/test-pi.js";
import type { ManagedSession } from "../../state.js";
import type { AgentRuntime } from "../../runtimes/registry.js";
import { getPiSession } from "../../runtimes/pi/runtime.js";
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
  const session = getPiSession(managed.runtime);
  session.modelRegistry.authStorage.reload = mock<typeof session.modelRegistry.authStorage.reload>(() => {});
  return managed;
}

function createNonPiManagedSession(sessionId: string): ManagedSession {
  const runtime: AgentRuntime = {
    prompt: async () => {},
    steer: async () => {},
    abort: async () => {},
    subscribe: () => () => {},
    getMessages: async () => [],
    close: async () => {},
  };

  return {
    id: sessionId,
    lastActivity: Date.now(),
    runtime,
  };
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
    expect(getPiSession(first.runtime).modelRegistry.authStorage.reload).toHaveBeenCalledTimes(1);
    expect(getPiSession(second.runtime).modelRegistry.authStorage.reload).toHaveBeenCalledTimes(1);
  });

  test("setApiKey skips non-pi runtimes when reloading auth", async () => {
    const piManaged = await createMockManagedSession("sess-pi");
    const nonPiManaged = createNonPiManagedSession("sess-non-pi");
    const sessions = new Map<string, ManagedSession>([
      [piManaged.id, piManaged],
      [nonPiManaged.id, nonPiManaged],
    ]);

    expect(() => setApiKey("anthropic", "sk-updated", sessions)).not.toThrow();
    expect(getPiSession(piManaged.runtime).modelRegistry.authStorage.reload).toHaveBeenCalledTimes(1);
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
    expect(getPiSession(managed.runtime).modelRegistry.authStorage.reload).toHaveBeenCalledTimes(1);
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
    expect(getPiSession(managed.runtime).modelRegistry.authStorage.reload).toHaveBeenCalledTimes(2);
  });
});

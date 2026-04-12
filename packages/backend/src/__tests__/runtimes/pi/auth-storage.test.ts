import { describe, test, expect, beforeEach, beforeAll, afterAll, afterEach } from "bun:test";
import { AuthStorage } from "@mariozechner/pi-coding-agent";
import { registerOAuthProvider, unregisterOAuthProvider, type OAuthProviderInterface } from "@mariozechner/pi-ai/oauth";
import { useTestDb } from "../../helpers/test-db.js";
import { useTestRepo } from "../../helpers/test-repo.js";
import { createServerState } from "../../helpers/server-state.js";
import { makeRequest } from "../../helpers/request.js";
import { buildRouter } from "../../../routes/index.js";
import { createProject } from "../../../project-store.js";
import { createNewSession } from "../../../runtimes/sessions-manager.js";
import {
  DbAuthStorageBackend,
  createDbBackedAuthStorage,
} from "../../../runtimes/pi/auth-storage.js";
import { installRuntimeHooks } from "../../../runtime-hooks.js";
import { getPiSession } from "../../../runtimes/pi/runtime.js";
import { clearPendingLogins } from "../../../routes/oauth.js";
import {
  getAuthCredential,
  setApiKeyCredential,
  setOAuthCredential,
} from "../../../auth-credentials-store.js";

const TEST_PROVIDER_ID = "test-oauth-wiring";

const testOAuthProvider: OAuthProviderInterface = {
  id: TEST_PROVIDER_ID,
  name: "Test OAuth Wiring",
  async login(callbacks) {
    callbacks.onAuth({ url: "https://example.test/oauth" });
    const code = await callbacks.onManualCodeInput?.();
    return {
      refresh: `refresh:${code}`,
      access: `access:${code}`,
      expires: Date.now() + 60_000,
    };
  },
  async refreshToken(credentials) {
    return credentials;
  },
  getApiKey(credentials) {
    return credentials.access;
  },
};

describe("auth storage wiring", () => {
  useTestDb();
  const repo = useTestRepo();

  beforeAll(() => {
    registerOAuthProvider(testOAuthProvider);
  });

  afterEach(() => {
    clearPendingLogins();
  });

  afterAll(() => {
    unregisterOAuthProvider(TEST_PROVIDER_ID);
  });

  describe("DB-backed AuthStorage backend", () => {
    test("reads API keys and OAuth credentials from auth_credentials via AuthStorage.fromStorage", async () => {
      setApiKeyCredential("anthropic", "sk-ant-db");
      setOAuthCredential("openai", {
        refresh: "refresh-openai",
        access: "access-openai",
        expires: Date.now() + 60_000,
      });

      const authStorage = AuthStorage.fromStorage(new DbAuthStorageBackend());

      await expect(authStorage.getApiKey("anthropic")).resolves.toBe("sk-ant-db");
      expect(authStorage.get("openai")).toEqual({
        type: "oauth",
        refresh: "refresh-openai",
        access: "access-openai",
        expires: expect.any(Number),
      });
    });

    test("prefers API keys over OAuth when both exist for the same provider", async () => {
      setApiKeyCredential("anthropic", "sk-ant-db");
      setOAuthCredential("anthropic", {
        refresh: "refresh-ant",
        access: "access-ant",
        expires: Date.now() + 60_000,
      });

      const authStorage = AuthStorage.fromStorage(new DbAuthStorageBackend());

      await expect(authStorage.getApiKey("anthropic")).resolves.toBe("sk-ant-db");
      expect(authStorage.get("anthropic")).toEqual({
        type: "api_key",
        key: "sk-ant-db",
      });
    });

    test("persists changes back to auth_credentials so fresh AuthStorage instances see them", async () => {
      const first = createDbBackedAuthStorage();
      first.set("anthropic", { type: "api_key", key: "sk-ant-fresh" });
      first.set("openai", {
        type: "oauth",
        refresh: "refresh-new",
        access: "access-new",
        expires: Date.now() + 60_000,
      });

      expect(getAuthCredential("anthropic", "api_key")).toEqual({
        provider: "anthropic",
        type: "api_key",
        value: "sk-ant-fresh",
        updatedAt: expect.any(String),
      });
      expect(getAuthCredential("openai", "oauth")).toEqual({
        provider: "openai",
        type: "oauth",
        value: {
          refresh: "refresh-new",
          access: "access-new",
          expires: expect.any(Number),
        },
        updatedAt: expect.any(String),
      });

      const second = createDbBackedAuthStorage();
      await expect(second.getApiKey("anthropic")).resolves.toBe("sk-ant-fresh");
      expect(second.get("openai")).toEqual({
        type: "oauth",
        refresh: "refresh-new",
        access: "access-new",
        expires: expect.any(Number),
      });

      first.remove("anthropic");
      first.remove("openai");
      expect(getAuthCredential("anthropic", "api_key")).toBeNull();
      expect(getAuthCredential("openai", "oauth")).toBeNull();
    });

    test("keeps environment variable fallback when no DB override exists", async () => {
      const prev = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = "sk-openai-env";

      try {
        const authStorage = createDbBackedAuthStorage();
        await expect(authStorage.getApiKey("openai")).resolves.toBe("sk-openai-env");
      } finally {
        if (prev === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = prev;
      }
    });
  });

  describe("live session propagation", () => {
    let state: ReturnType<typeof createServerState>;
    let router: ReturnType<typeof buildRouter>;
    let projectId: number;

    beforeEach(() => {
      state = createServerState();
      router = buildRouter();
      projectId = createProject("Test Project", repo.dir, "main").id;
    });

    test("new sessions create fresh auth storage instances", async () => {
      const first = await createNewSession(state, projectId, repo.dir);
      const second = await createNewSession(state, projectId, repo.dir);

      expect(getPiSession(first.runtime).modelRegistry.authStorage).not.toBe(getPiSession(second.runtime).modelRegistry.authStorage);
    });

    test("PUT/DELETE api key routes propagate to existing sessions", async () => {
      const managed = await createNewSession(state, projectId, repo.dir);

      const putRes = await router.handle(
        makeRequest("PUT", "/api/auth/api-keys/anthropic", { apiKey: "sk-updated" }),
        state,
      );
      expect(putRes!.status).toBe(200);
      await expect(getPiSession(managed.runtime).modelRegistry.authStorage.getApiKey("anthropic")).resolves.toBe("sk-updated");

      const delRes = await router.handle(
        makeRequest("DELETE", "/api/auth/api-keys/anthropic"),
        state,
      );
      expect(delRes!.status).toBe(204);
      await expect(getPiSession(managed.runtime).modelRegistry.authStorage.getApiKey("anthropic")).resolves.toBeUndefined();
    });

    test("OAuth callback/delete updates propagate to existing sessions", async () => {
      const managed = await createNewSession(state, projectId, repo.dir);

      const startRes = await router.handle(
        makeRequest("POST", `/api/oauth/start/${TEST_PROVIDER_ID}`),
        state,
      );
      expect(startRes!.status).toBe(200);

      const callbackRes = await router.handle(
        makeRequest("POST", `/api/oauth/callback/${TEST_PROVIDER_ID}`, { code: "session-code" }),
        state,
      );
      expect(callbackRes!.status).toBe(200);
      await expect(getPiSession(managed.runtime).modelRegistry.authStorage.getApiKey(TEST_PROVIDER_ID)).resolves.toBe("access:session-code");

      const deleteRes = await router.handle(
        makeRequest("DELETE", `/api/oauth/${TEST_PROVIDER_ID}`),
        state,
      );
      expect(deleteRes!.status).toBe(204);
      await expect(getPiSession(managed.runtime).modelRegistry.authStorage.getApiKey(TEST_PROVIDER_ID)).resolves.toBeUndefined();
    });

    test("DB-backed auth writes notify runtime hooks so other sessions can reload", async () => {
      const first = await createNewSession(state, projectId, repo.dir);
      const second = await createNewSession(state, projectId, repo.dir);

      const uninstall = installRuntimeHooks(state);

      try {
        getPiSession(first.runtime).modelRegistry.authStorage.set("anthropic", {
          type: "api_key",
          key: "sk-from-first-session",
        });

        await expect(getPiSession(second.runtime).modelRegistry.authStorage.getApiKey("anthropic")).resolves.toBe("sk-from-first-session");
      } finally {
        uninstall();
      }
    });
  });
});

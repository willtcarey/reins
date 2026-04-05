import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import {
  registerOAuthProvider,
  unregisterOAuthProvider,
  type OAuthProviderInterface,
} from "@mariozechner/pi-ai/oauth";
import { useTestDb } from "../helpers/test-db.js";
import { makeRequest } from "../helpers/request.js";
import { createServerState } from "../helpers/server-state.js";
import { buildRouter } from "../../routes/index.js";
import { clearPendingLogins } from "../../routes/oauth.js";
import { getSetting } from "../../settings-store.js";

const TEST_PROVIDER_ID = "test-oauth";

const testOAuthProvider: OAuthProviderInterface = {
  id: TEST_PROVIDER_ID,
  name: "Test OAuth",
  async login(callbacks) {
    callbacks.onAuth({
      url: "https://example.test/oauth",
      instructions: "Paste the callback URL",
    });
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

describe("oauth routes", () => {
  useTestDb();

  beforeEach(() => {
    registerOAuthProvider(testOAuthProvider);
  });

  afterEach(() => {
    clearPendingLogins();
    unregisterOAuthProvider(TEST_PROVIDER_ID);
  });

  const setup = () => {
    const state = createServerState();
    const router = buildRouter();
    return { state, router };
  };

  // ---- GET /api/oauth/providers --------------------------------------------

  describe("GET /api/oauth/providers", () => {
    test("returns list of OAuth providers", async () => {
      const { router, state } = setup();
      const res = await router.handle(
        makeRequest("GET", "/api/oauth/providers"),
        state,
      );
      expect(res!.status).toBe(200);

      const body = await res!.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThan(0);

      // Each provider should have id, name, configured
      const first = body[0];
      expect(first).toHaveProperty("id");
      expect(first).toHaveProperty("name");
      expect(first).toHaveProperty("configured");
      expect(typeof first.id).toBe("string");
      expect(typeof first.name).toBe("string");
      expect(typeof first.configured).toBe("boolean");
    });

    test("all providers show configured: false when no credentials stored", async () => {
      const { router, state } = setup();
      const res = await router.handle(
        makeRequest("GET", "/api/oauth/providers"),
        state,
      );
      const body = await res!.json();

      for (const provider of body) {
        expect(provider.configured).toBe(false);
      }
    });
  });

  // ---- DELETE /api/oauth/:providerId ---------------------------------------

  describe("DELETE /api/oauth/:providerId", () => {
    test("returns 404 for unknown provider", async () => {
      const { router, state } = setup();
      const res = await router.handle(
        makeRequest("DELETE", "/api/oauth/nonexistent-provider"),
        state,
      );
      expect(res!.status).toBe(404);
    });

    test("returns 204 for valid provider (even if no credentials stored)", async () => {
      const { router, state } = setup();
      const res = await router.handle(
        makeRequest("DELETE", `/api/oauth/${TEST_PROVIDER_ID}`),
        state,
      );
      expect(res!.status).toBe(204);
    });

    test("removes stored OAuth credentials immediately", async () => {
      const { router, state } = setup();

      const startRes = await router.handle(
        makeRequest("POST", `/api/oauth/start/${TEST_PROVIDER_ID}`),
        state,
      );
      expect(startRes!.status).toBe(200);

      const callbackRes = await router.handle(
        makeRequest("POST", `/api/oauth/callback/${TEST_PROVIDER_ID}`, { code: "old" }),
        state,
      );
      expect(callbackRes!.status).toBe(200);

      const res = await router.handle(
        makeRequest("DELETE", `/api/oauth/${TEST_PROVIDER_ID}`),
        state,
      );

      expect(res!.status).toBe(204);
      expect(getSetting("oauth_test-oauth")).toBeNull();
    });
  });

  // ---- POST /api/oauth/callback/:providerId --------------------------------

  describe("POST /api/oauth/callback/:providerId", () => {
    test("returns 400 when no pending login", async () => {
      const { router, state } = setup();
      const res = await router.handle(
        makeRequest("POST", "/api/oauth/callback/anthropic", { code: "test" }),
        state,
      );
      expect(res!.status).toBe(400);
    });

    test("returns 400 for invalid JSON body", async () => {
      const { router, state } = setup();
      const req = makeRequest("/api/oauth/callback/anthropic", {
        method: "POST",
        body: "not-json{{{",
        headers: { "Content-Type": "application/json" },
      });
      const res = await router.handle(req, state);
      expect(res!.status).toBe(400);
    });

    test("returns 400 for missing code field", async () => {
      const { router, state } = setup();
      const startRes = await router.handle(
        makeRequest("POST", `/api/oauth/start/${TEST_PROVIDER_ID}`),
        state,
      );
      expect(startRes!.status).toBe(200);

      const res = await router.handle(
        makeRequest("POST", `/api/oauth/callback/${TEST_PROVIDER_ID}`, { notCode: "x" }),
        state,
      );
      expect(res!.status).toBe(400);
    });

    test("stores OAuth credentials in the DB-backed auth store after callback", async () => {
      const { router, state } = setup();
      const startRes = await router.handle(
        makeRequest("POST", `/api/oauth/start/${TEST_PROVIDER_ID}`),
        state,
      );
      expect(startRes!.status).toBe(200);

      const res = await router.handle(
        makeRequest("POST", `/api/oauth/callback/${TEST_PROVIDER_ID}`, { code: "callback-code" }),
        state,
      );
      expect(res!.status).toBe(200);

      expect(getSetting("oauth_test-oauth")).toEqual({
        refresh: "refresh:callback-code",
        access: "access:callback-code",
        expires: expect.any(Number),
      });
    });
  });

  // ---- POST /api/oauth/start/:providerId -----------------------------------

  describe("POST /api/oauth/start/:providerId", () => {
    test("returns 404 for unknown provider", async () => {
      const { router, state } = setup();
      const res = await router.handle(
        makeRequest("POST", "/api/oauth/start/nonexistent-provider"),
        state,
      );
      expect(res!.status).toBe(404);
    });
  });
});

import { describe, test, expect, afterEach } from "bun:test";
import { useTestDb } from "../helpers/test-db.js";
import { createTestState } from "../helpers/test-state.js";
import { buildRouter } from "../../routes/index.js";
import { clearPendingLogins } from "../../routes/oauth.js";

function makeRequest(method: string, path: string, body?: unknown): Request {
  const opts: RequestInit = { method };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
    opts.headers = { "Content-Type": "application/json" };
  }
  return new Request(`http://localhost${path}`, opts);
}

describe("oauth routes", () => {
  useTestDb();

  afterEach(() => {
    clearPendingLogins();
  });

  const setup = () => {
    const state = createTestState();
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
      // Get a real provider ID
      const listRes = await router.handle(
        makeRequest("GET", "/api/oauth/providers"),
        state,
      );
      const providers = await listRes!.json();
      const providerId = providers[0].id;

      const res = await router.handle(
        makeRequest("DELETE", `/api/oauth/${providerId}`),
        state,
      );
      expect(res!.status).toBe(204);
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
      const req = new Request("http://localhost/api/oauth/callback/anthropic", {
        method: "POST",
        body: "not-json{{{",
        headers: { "Content-Type": "application/json" },
      });
      const res = await router.handle(req, state);
      expect(res!.status).toBe(400);
    });

    test("returns 400 for missing code field", async () => {
      const { router, state } = setup();
      const res = await router.handle(
        makeRequest("POST", "/api/oauth/callback/anthropic", { notCode: "x" }),
        state,
      );
      expect(res!.status).toBe(400);
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

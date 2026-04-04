import { describe, test, expect } from "bun:test";
import { useTestDb } from "../helpers/test-db.js";
import { createTestState } from "../helpers/test-state.js";
import { buildRouter } from "../../routes/index.js";
import { setSetting } from "../../settings-store.js";

function makeRequest(method: string, path: string, body?: unknown): Request {
  const opts: RequestInit = { method };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
    opts.headers = { "Content-Type": "application/json" };
  }
  return new Request(`http://localhost${path}`, opts);
}

describe("settings routes", () => {
  useTestDb();

  const setup = () => {
    const state = createTestState();
    const router = buildRouter();
    return { state, router };
  };

  // ---- GET /api/settings ---------------------------------------------------

  describe("GET /api/settings", () => {
    test("returns empty array when no settings", async () => {
      const { router, state } = setup();
      const res = await router.handle(makeRequest("GET", "/api/settings"), state);
      expect(res!.status).toBe(200);
      expect(await res!.json()).toEqual([]);
    });

    test("returns redacted values after setting API keys", async () => {
      const { router, state } = setup();

      setSetting("api_key_anthropic", "sk-secret", state.encryptionSecret);
      setSetting("default_model", { provider: "anthropic", modelId: "claude-4", thinkingLevel: "high" }, state.encryptionSecret);

      const res = await router.handle(makeRequest("GET", "/api/settings"), state);
      const body = await res!.json();

      expect(body).toHaveLength(2);
      const apiKey = body.find((e: any) => e.key === "api_key_anthropic");
      expect(apiKey.value).toBe("********");
      expect(apiKey.redacted).toBe(true);

      const model = body.find((e: any) => e.key === "default_model");
      expect(model.value).toEqual({ provider: "anthropic", modelId: "claude-4", thinkingLevel: "high" });
      expect(model.redacted).toBe(false);
    });
  });

  // ---- GET /api/settings/:key ----------------------------------------------

  describe("GET /api/settings/:key", () => {
    test("returns 404 for missing key", async () => {
      const { router, state } = setup();
      const res = await router.handle(makeRequest("GET", "/api/settings/default_model"), state);
      expect(res!.status).toBe(404);
    });

    test("returns value for default_model", async () => {
      const { router, state } = setup();
      const model = { provider: "anthropic", modelId: "claude-4", thinkingLevel: "high" };
      setSetting("default_model", model, state.encryptionSecret);

      const res = await router.handle(makeRequest("GET", "/api/settings/default_model"), state);
      expect(res!.status).toBe(200);
      const body = await res!.json();
      expect(body).toEqual({ key: "default_model", value: model });
    });

    test("returns configured: true for API keys (redacted)", async () => {
      const { router, state } = setup();
      setSetting("api_key_anthropic", "sk-secret", state.encryptionSecret);

      const res = await router.handle(makeRequest("GET", "/api/settings/api_key_anthropic"), state);
      expect(res!.status).toBe(200);
      const body = await res!.json();
      expect(body).toEqual({ key: "api_key_anthropic", configured: true });
      expect(body.value).toBeUndefined();
    });

    test("returns 400 for unknown key", async () => {
      const { router, state } = setup();
      const res = await router.handle(makeRequest("GET", "/api/settings/bogus_key"), state);
      expect(res!.status).toBe(400);
    });
  });

  // ---- PUT /api/settings/:key ----------------------------------------------

  describe("PUT /api/settings/:key", () => {
    test("round-trips with GET", async () => {
      const { router, state } = setup();
      const model = { provider: "openai", modelId: "gpt-5", thinkingLevel: "medium" };

      const putRes = await router.handle(
        makeRequest("PUT", "/api/settings/default_model", model),
        state,
      );
      expect(putRes!.status).toBe(200);

      const getRes = await router.handle(
        makeRequest("GET", "/api/settings/default_model"),
        state,
      );
      const body = await getRes!.json();
      expect(body.value).toEqual(model);
    });

    test("returns 400 for unknown key", async () => {
      const { router, state } = setup();
      const res = await router.handle(
        makeRequest("PUT", "/api/settings/bogus_key", "value"),
        state,
      );
      expect(res!.status).toBe(400);
    });

    test("returns 400 for invalid value shape", async () => {
      const { router, state } = setup();
      // default_model expects an object, not a string
      const res = await router.handle(
        makeRequest("PUT", "/api/settings/default_model", "not-an-object"),
        state,
      );
      expect(res!.status).toBe(400);
    });

    test("returns 400 for invalid JSON body", async () => {
      const { router, state } = setup();
      const req = new Request("http://localhost/api/settings/default_model", {
        method: "PUT",
        body: "not-json{{{",
        headers: { "Content-Type": "application/json" },
      });
      const res = await router.handle(req, state);
      expect(res!.status).toBe(400);
    });
  });

  // ---- DELETE /api/settings/:key -------------------------------------------

  describe("DELETE /api/settings/:key", () => {
    test("GET returns 404 after delete", async () => {
      const { router, state } = setup();
      const model = { provider: "anthropic", modelId: "claude-4", thinkingLevel: "high" };
      setSetting("default_model", model, state.encryptionSecret);

      const delRes = await router.handle(
        makeRequest("DELETE", "/api/settings/default_model"),
        state,
      );
      expect(delRes!.status).toBe(204);

      const getRes = await router.handle(
        makeRequest("GET", "/api/settings/default_model"),
        state,
      );
      expect(getRes!.status).toBe(404);
    });

    test("returns 400 for unknown key", async () => {
      const { router, state } = setup();
      const res = await router.handle(
        makeRequest("DELETE", "/api/settings/bogus_key"),
        state,
      );
      expect(res!.status).toBe(400);
    });
  });
});

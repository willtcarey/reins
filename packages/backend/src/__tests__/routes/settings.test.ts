import { describe, test, expect } from "bun:test";
import { useTestDb } from "../helpers/test-db.js";
import { makeRequest } from "../helpers/request.js";
import { createServerState } from "../helpers/server-state.js";
import { buildRouter } from "../../routes/index.js";
import { getSetting, setSetting } from "../../settings-store.js";

describe("settings routes", () => {
  useTestDb();

  const setup = () => {
    const state = createServerState();
    const router = buildRouter();
    return { state, router };
  };

  describe("GET /api/settings", () => {
    test("returns empty array when no settings", async () => {
      const { router, state } = setup();
      const res = await router.handle(makeRequest("GET", "/api/settings"), state);
      expect(res!.status).toBe(200);
      expect(await res!.json()).toEqual([]);
    });

    test("returns stored settings", async () => {
      const { router, state } = setup();

      setSetting("default_model", { provider: "anthropic", modelId: "claude-4", thinkingLevel: "high" });
      setSetting("utility_model", { provider: "anthropic", modelId: "claude-haiku-4-5", thinkingLevel: "minimal" });

      const res = await router.handle(makeRequest("GET", "/api/settings"), state);
      const body = await res!.json();

      expect(body).toEqual([
        {
          key: "default_model",
          value: { provider: "anthropic", modelId: "claude-4", thinkingLevel: "high" },
        },
        {
          key: "utility_model",
          value: { provider: "anthropic", modelId: "claude-haiku-4-5", thinkingLevel: "minimal" },
        },
      ]);
    });

    test("returns only requested keys when key query params are provided", async () => {
      const { router, state } = setup();

      setSetting("default_model", { provider: "anthropic", modelId: "claude-4", thinkingLevel: "high" });
      setSetting("utility_model", { provider: "anthropic", modelId: "claude-haiku-4-5", thinkingLevel: "minimal" });

      const res = await router.handle(
        makeRequest("GET", "/api/settings?key=utility_model&key=default_model"),
        state,
      );

      expect(res!.status).toBe(200);
      expect(await res!.json()).toEqual([
        {
          key: "default_model",
          value: { provider: "anthropic", modelId: "claude-4", thinkingLevel: "high" },
        },
        {
          key: "utility_model",
          value: { provider: "anthropic", modelId: "claude-haiku-4-5", thinkingLevel: "minimal" },
        },
      ]);
    });

    test("ignores unknown requested keys", async () => {
      const { router, state } = setup();
      setSetting("default_model", { provider: "anthropic", modelId: "claude-4", thinkingLevel: "high" });

      const res = await router.handle(makeRequest("GET", "/api/settings?key=default_model&key=nope"), state);

      expect(res!.status).toBe(200);
      expect(await res!.json()).toEqual([
        {
          key: "default_model",
          value: { provider: "anthropic", modelId: "claude-4", thinkingLevel: "high" },
        },
      ]);
    });

    test("returns an empty array when only unknown keys are requested", async () => {
      const { router, state } = setup();
      setSetting("default_model", { provider: "anthropic", modelId: "claude-4", thinkingLevel: "high" });

      const res = await router.handle(makeRequest("GET", "/api/settings?key=nope"), state);

      expect(res!.status).toBe(200);
      expect(await res!.json()).toEqual([]);
    });
  });

  describe("GET /api/settings/:key", () => {
    test("returns 404 for missing key", async () => {
      const { router, state } = setup();
      const res = await router.handle(makeRequest("GET", "/api/settings/default_model"), state);
      expect(res!.status).toBe(404);
    });

    test("returns value for default_model", async () => {
      const { router, state } = setup();
      const model = { provider: "anthropic", modelId: "claude-4", thinkingLevel: "high" } as const;
      setSetting("default_model", model);

      const res = await router.handle(makeRequest("GET", "/api/settings/default_model"), state);
      expect(res!.status).toBe(200);
      expect(await res!.json()).toEqual({ key: "default_model", value: model });
    });

    test("returns value for utility_model", async () => {
      const { router, state } = setup();
      const model = { provider: "anthropic", modelId: "claude-haiku-4-5", thinkingLevel: "minimal" } as const;
      setSetting("utility_model", model);

      const res = await router.handle(makeRequest("GET", "/api/settings/utility_model"), state);
      expect(res!.status).toBe(200);
      expect(await res!.json()).toEqual({ key: "utility_model", value: model });
    });

    test("returns 400 for unknown key", async () => {
      const { router, state } = setup();
      const res = await router.handle(makeRequest("GET", "/api/settings/api_key_anthropic"), state);
      expect(res!.status).toBe(400);
    });
  });

  describe("PUT /api/settings/:key", () => {
    test("round-trips with GET", async () => {
      const { router, state } = setup();
      const model = { provider: "openai", modelId: "gpt-5", thinkingLevel: "medium" } as const;

      const putRes = await router.handle(
        makeRequest("PUT", "/api/settings/default_model", model),
        state,
      );
      expect(putRes!.status).toBe(200);

      const getRes = await router.handle(
        makeRequest("GET", "/api/settings/default_model"),
        state,
      );
      expect(await getRes!.json()).toEqual({ key: "default_model", value: model });
    });

    test("returns 400 for unknown key", async () => {
      const { router, state } = setup();
      const res = await router.handle(
        makeRequest("PUT", "/api/settings/api_key_anthropic", "value"),
        state,
      );
      expect(res!.status).toBe(400);
    });

    test("returns 400 for invalid value shape", async () => {
      const { router, state } = setup();
      const res = await router.handle(
        makeRequest("PUT", "/api/settings/default_model", "not-an-object"),
        state,
      );
      expect(res!.status).toBe(400);
    });

    test("returns 400 for invalid JSON body", async () => {
      const { router, state } = setup();
      const req = makeRequest("/api/settings/default_model", {
        method: "PUT",
        body: "not-json{{{",
        headers: { "Content-Type": "application/json" },
      });
      const res = await router.handle(req, state);
      expect(res!.status).toBe(400);
    });
  });

  describe("DELETE /api/settings/:key", () => {
    test("GET returns 404 after delete", async () => {
      const { router, state } = setup();
      const model = { provider: "anthropic", modelId: "claude-4", thinkingLevel: "high" } as const;
      setSetting("default_model", model);

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
        makeRequest("DELETE", "/api/settings/api_key_anthropic"),
        state,
      );
      expect(res!.status).toBe(400);
    });

    test("removes persisted settings", async () => {
      const { router, state } = setup();
      setSetting("default_model", { provider: "anthropic", modelId: "claude-4", thinkingLevel: "high" });

      const res = await router.handle(
        makeRequest("DELETE", "/api/settings/default_model"),
        state,
      );

      expect(res!.status).toBe(204);
      expect(getSetting("default_model")).toBeNull();
    });
  });
});

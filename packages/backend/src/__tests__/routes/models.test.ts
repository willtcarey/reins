import { describe, test, expect } from "bun:test";
import { useTestDb } from "../helpers/test-db.js";
import { makeRequest } from "../helpers/request.js";
import { createServerState } from "../helpers/server-state.js";
import { buildRouter } from "../../routes/index.js";
import { setSetting } from "../../settings-store.js";

describe("GET /api/models", () => {
  useTestDb();

  const setup = () => {
    const state = createServerState();
    const router = buildRouter();
    return { state, router };
  };

  test("returns expected provider/model structure", async () => {
    const { router, state } = setup();
    const res = await router.handle(
      makeRequest("/api/models"),
      state,
    );
    expect(res!.status).toBe(200);

    const body = await res!.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);

    // Check structure of first provider entry
    const first = body[0];
    expect(first).toHaveProperty("provider");
    expect(first).toHaveProperty("hasKey");
    expect(first).toHaveProperty("keySource");
    expect(first).toHaveProperty("models");
    expect(Array.isArray(first.models)).toBe(true);

    // Check anthropic is in the list (known provider)
    const anthropic = body.find((p: any) => p.provider === "anthropic");
    expect(anthropic).toBeDefined();
    expect(anthropic.models.length).toBeGreaterThan(0);

    // Check model structure
    const model = anthropic.models[0];
    expect(model).toHaveProperty("id");
    expect(model).toHaveProperty("name");
    expect(model).toHaveProperty("reasoning");
    expect(model).toHaveProperty("contextWindow");
    expect(model).toHaveProperty("maxTokens");
  });

  test("hasKey reflects DB-configured keys", async () => {
    const { router, state } = setup();

    // Before setting key — anthropic may or may not have env var
    const res1 = await router.handle(
      makeRequest("/api/models"),
      state,
    );
    const before = await res1!.json();
    const anthropicBefore = before.find((p: any) => p.provider === "anthropic");

    // Set a DB key
    setSetting("api_key_anthropic", "sk-test-key");

    const res2 = await router.handle(
      makeRequest("/api/models"),
      state,
    );
    const after = await res2!.json();
    const anthropicAfter = after.find((p: any) => p.provider === "anthropic");

    expect(anthropicAfter.hasKey).toBe(true);
    expect(anthropicAfter.keySource).toBe("db");

    // If the provider didn't have an env key before, verify the change
    if (!anthropicBefore.hasKey) {
      expect(anthropicBefore.keySource).toBeNull();
    }
  });

  test("keySources includes all configured sources", async () => {
    const { router, state } = setup();

    // Check that keySources array is present
    const res1 = await router.handle(
      makeRequest("/api/models"),
      state,
    );
    const body1 = await res1!.json();
    const first = body1[0];
    expect(first).toHaveProperty("keySources");
    expect(Array.isArray(first.keySources)).toBe(true);
  });

  test("keySources shows both db and env when both are configured", async () => {
    const { router, state } = setup();

    // Set a DB key for anthropic
    setSetting("api_key_anthropic", "sk-test-key");

    // Also set an env var
    const origEnv = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-env-test";

    try {
      const res = await router.handle(
        makeRequest("/api/models"),
        state,
      );
      const body = await res!.json();
      const anthropic = body.find((p: any) => p.provider === "anthropic");

      expect(anthropic.hasKey).toBe(true);
      expect(anthropic.keySource).toBe("db"); // highest priority
      expect(anthropic.keySources).toContain("db");
      expect(anthropic.keySources).toContain("env");
    } finally {
      if (origEnv === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = origEnv;
      }
    }
  });

  test("keySources shows oauth when OAuth credentials are stored", async () => {
    const { router, state } = setup();

    // Store OAuth credentials
    setSetting("oauth_anthropic", {
      refresh: "refresh-token",
      access: "access-token",
      expires: Date.now() + 3600_000,
    });

    const res = await router.handle(
      makeRequest("/api/models"),
      state,
    );
    const body = await res!.json();
    const anthropic = body.find((p: any) => p.provider === "anthropic");

    expect(anthropic.hasKey).toBe(true);
    expect(anthropic.keySources).toContain("oauth");
  });

  test("keySources shows env and oauth when both are configured", async () => {
    const { router, state } = setup();

    // Set env var + OAuth credentials
    const origEnv = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-env-test";

    setSetting("oauth_anthropic", {
      refresh: "refresh-token",
      access: "access-token",
      expires: Date.now() + 3600_000,
    });

    try {
      const res = await router.handle(
        makeRequest("/api/models"),
        state,
      );
      const body = await res!.json();
      const anthropic = body.find((p: any) => p.provider === "anthropic");

      expect(anthropic.hasKey).toBe(true);
      expect(anthropic.keySource).toBe("env"); // env has higher priority than oauth
      expect(anthropic.keySources).toContain("env");
      expect(anthropic.keySources).toContain("oauth");
    } finally {
      if (origEnv === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = origEnv;
      }
    }
  });

  test("providers without DB keys show env source when env var set", async () => {
    const { router, state } = setup();
    const res = await router.handle(
      makeRequest("/api/models"),
      state,
    );
    const body = await res!.json();

    // Providers without our DB key settings should show null or "env"
    for (const provider of body) {
      if (provider.keySource === "env") {
        expect(provider.hasKey).toBe(true);
      }
      if (provider.keySource === null) {
        // For providers where we don't store a key in DB and no env var exists
        // hasKey might still be true for providers that use credentials files
        // Just verify the structure is valid
        expect(typeof provider.hasKey).toBe("boolean");
      }
    }
  });
});

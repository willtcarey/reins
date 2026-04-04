import { describe, test, expect } from "bun:test";
import { useTestDb } from "../helpers/test-db.js";
import { createTestState } from "../helpers/test-state.js";
import { buildRouter } from "../../routes/index.js";
import { setSetting } from "../../settings-store.js";

describe("GET /api/models", () => {
  useTestDb();

  const setup = () => {
    const state = createTestState();
    const router = buildRouter();
    return { state, router };
  };

  test("returns expected provider/model structure", async () => {
    const { router, state } = setup();
    const res = await router.handle(
      new Request("http://localhost/api/models"),
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
      new Request("http://localhost/api/models"),
      state,
    );
    const before = await res1!.json();
    const anthropicBefore = before.find((p: any) => p.provider === "anthropic");

    // Set a DB key
    setSetting("api_key_anthropic", "sk-test-key", state.encryptionSecret);

    const res2 = await router.handle(
      new Request("http://localhost/api/models"),
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

  test("providers without DB keys show env source when env var set", async () => {
    const { router, state } = setup();
    const res = await router.handle(
      new Request("http://localhost/api/models"),
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

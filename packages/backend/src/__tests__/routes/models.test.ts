import { describe, test, expect } from "bun:test";
import { useTestDb } from "../helpers/test-db.js";
import { makeRequest } from "../helpers/request.js";
import { createServerState } from "../helpers/server-state.js";
import { buildRouter } from "../../routes/index.js";
import { setApiKeyCredential, setOAuthCredential } from "../../auth-credentials-store.js";

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

    const first = body[0];
    expect(first).toHaveProperty("provider");
    expect(first).toHaveProperty("hasKey");
    expect(first).toHaveProperty("keySource");
    expect(first).toHaveProperty("models");
    expect(Array.isArray(first.models)).toBe(true);

    const anthropic = body.find((p: any) => p.provider === "anthropic");
    expect(anthropic).toBeDefined();
    expect(anthropic.models.length).toBeGreaterThan(0);

    const model = anthropic.models[0];
    expect(model).toHaveProperty("id");
    expect(model).toHaveProperty("name");
    expect(model).toHaveProperty("reasoning");
    expect(model).toHaveProperty("contextWindow");
    expect(model).toHaveProperty("maxTokens");
  });

  test("hasKey reflects DB-configured API keys", async () => {
    const { router, state } = setup();

    setApiKeyCredential("anthropic", "sk-test-key");

    const res = await router.handle(
      makeRequest("/api/models"),
      state,
    );
    const body = await res!.json();
    const anthropic = body.find((p: any) => p.provider === "anthropic");

    expect(anthropic.hasKey).toBe(true);
    expect(anthropic.keySource).toBe("db");
  });

  test("keySources includes all configured sources", async () => {
    const { router, state } = setup();
    const res = await router.handle(
      makeRequest("/api/models"),
      state,
    );
    const body = await res!.json();
    const first = body[0];
    expect(first).toHaveProperty("keySources");
    expect(Array.isArray(first.keySources)).toBe(true);
  });

  test("keySources shows both db and env when both are configured", async () => {
    const { router, state } = setup();

    setApiKeyCredential("anthropic", "sk-test-key");

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
      expect(anthropic.keySource).toBe("db");
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

    setOAuthCredential("anthropic", {
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

    const origEnv = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-env-test";

    setOAuthCredential("anthropic", {
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
      expect(anthropic.keySource).toBe("env");
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

  test("includes extension-registered providers that rely on local auth", async () => {
    const { router, state } = setup();

    const res = await router.handle(
      makeRequest("/api/models"),
      state,
    );
    const body = await res!.json();
    const claudeAgentSdk = body.find((p: any) => p.provider === "claude-agent-sdk");

    expect(claudeAgentSdk).toBeDefined();
    expect(claudeAgentSdk.hasKey).toBe(true);
    expect(claudeAgentSdk.keySource).toBe("local");
    expect(claudeAgentSdk.keySources).toContain("local");
    expect(claudeAgentSdk.models.length).toBeGreaterThan(0);
  });
});

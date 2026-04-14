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
    expect(first).toHaveProperty("runtimeType");
    expect(first).toHaveProperty("provider");
    expect(first).toHaveProperty("isAvailable");
    expect(first).toHaveProperty("availabilitySource");
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

  test("isAvailable reflects DB-configured API keys", async () => {
    const { router, state } = setup();

    setApiKeyCredential("anthropic", "sk-test-key");

    const res = await router.handle(
      makeRequest("/api/models"),
      state,
    );
    const body = await res!.json();
    const anthropic = body.find((p: any) => p.provider === "anthropic");

    expect(anthropic.isAvailable).toBe(true);
    expect(anthropic.availabilitySource).toBe("db");
  });

  test("availabilitySources includes all configured sources", async () => {
    const { router, state } = setup();
    const res = await router.handle(
      makeRequest("/api/models"),
      state,
    );
    const body = await res!.json();
    const first = body[0];
    expect(first).toHaveProperty("availabilitySources");
    expect(Array.isArray(first.availabilitySources)).toBe(true);
  });

  test("availabilitySources shows both db and env when both are configured", async () => {
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

      expect(anthropic.isAvailable).toBe(true);
      expect(anthropic.availabilitySource).toBe("db");
      expect(anthropic.availabilitySources).toContain("db");
      expect(anthropic.availabilitySources).toContain("env");
    } finally {
      if (origEnv === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = origEnv;
      }
    }
  });

  test("availabilitySources shows oauth when OAuth credentials are stored", async () => {
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

    expect(anthropic.isAvailable).toBe(true);
    expect(anthropic.availabilitySources).toContain("oauth");
  });

  test("availabilitySources shows env and oauth when both are configured", async () => {
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

      expect(anthropic.isAvailable).toBe(true);
      expect(anthropic.availabilitySource).toBe("env");
      expect(anthropic.availabilitySources).toContain("env");
      expect(anthropic.availabilitySources).toContain("oauth");
    } finally {
      if (origEnv === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = origEnv;
      }
    }
  });

  test("marks Claude SDK provider as locally available without configured keys", async () => {
    const { router, state } = setup();

    const res = await router.handle(
      makeRequest("/api/models"),
      state,
    );
    const body = await res!.json();

    const claudeProvider = body.find((p: any) =>
      p.runtimeType === "claude_agent_sdk" && p.provider === "claude_agent_sdk");

    expect(claudeProvider).toBeDefined();
    expect(claudeProvider.isAvailable).toBe(true);
    expect(claudeProvider.availabilitySource).toBe("local");
    expect(claudeProvider.availabilitySources).toEqual(["local"]);
    expect(claudeProvider.models.some((model: any) => model.id === "claude-sonnet-4-6")).toBe(true);
  });

  test("returns providers sorted by provider name", async () => {
    const { router, state } = setup();
    const res = await router.handle(
      makeRequest("/api/models"),
      state,
    );
    const body = await res!.json();
    const providerNames = body.map((p: any) => p.provider);
    const sorted = [...providerNames].sort((a: string, b: string) => a.localeCompare(b));
    expect(providerNames).toEqual(sorted);
  });

  test("does not expose local availability sources outside Claude SDK runtime", async () => {
    const { router, state } = setup();

    const res = await router.handle(
      makeRequest("/api/models"),
      state,
    );
    const body = await res!.json();

    const localEntries = body.filter((p: any) =>
      p.availabilitySource === "local" || p.availabilitySources.includes("local"));

    expect(localEntries.length).toBeGreaterThan(0);
    expect(localEntries.every((p: any) => p.runtimeType === "claude_agent_sdk" && p.provider === "claude_agent_sdk")).toBe(true);
  });
});

/**
 * Tests for the models scripting API functions.
 */

import { describe, test, expect } from "bun:test";
import { useTestDb } from "../helpers/test-db.js";
import "../helpers/server-state.js";
import { setApiKeyCredential } from "../../auth-credentials-store.js";
import { buildProviderList } from "../../runtimes/pi/models-registry.js";
import { modelsListFunction, modelsListProvidersFunction } from "../../scripting/models.js";
import type { ApiContext } from "../../scripting/api-registry.js";
import type { ManagedSession } from "../../state.js";

function noop() {}

function makeCtx(overrides?: Partial<ApiContext>): ApiContext {
  return {
    projectId: 1,
    sessionId: "test-session",
    taskId: null,
    broadcast: noop,
    sessions: new Map<string, ManagedSession>(),
    ...overrides,
  };
}

describe("models.list", () => {
  useTestDb();

  test("returns expected shape", async () => {
    const ctx = makeCtx();
    const result = await modelsListFunction.execute({}, ctx);

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);

    const first = result[0];
    expect(first).toHaveProperty("runtimeType");
    expect(first).toHaveProperty("provider");
    expect(first).toHaveProperty("hasKey");
    expect(first).toHaveProperty("keySource");
    expect(first).toHaveProperty("models");
    expect(Array.isArray(first.models)).toBe(true);
  });

  test("includes anthropic provider with models", async () => {
    const ctx = makeCtx();
    const result = await modelsListFunction.execute({}, ctx);

    const anthropic = result.find((p) => p.provider === "anthropic");
    expect(anthropic).toBeDefined();
    expect(anthropic!.models.length).toBeGreaterThan(0);

    const model = anthropic!.models[0];
    expect(model).toHaveProperty("id");
    expect(model).toHaveProperty("name");
    expect(model).toHaveProperty("reasoning");
    expect(model).toHaveProperty("contextWindow");
    expect(model).toHaveProperty("maxTokens");
  });

  test("reflects DB-configured keys", async () => {
    const ctx = makeCtx();
    setApiKeyCredential("anthropic", "sk-test-key");

    const result = await modelsListFunction.execute({}, ctx);
    const anthropic = result.find((p) => p.provider === "anthropic");
    expect(anthropic!.hasKey).toBe(true);
    expect(anthropic!.keySource).toBe("db");
  });
});

describe("buildProviderList", () => {
  useTestDb();

  test("returns same shape as models.list", async () => {
    const result = await buildProviderList();

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);

    const anthropic = result.find((p) => p.provider === "anthropic");
    expect(anthropic).toBeDefined();
  });
});

describe("models.listProviders", () => {
  useTestDb();

  test("returns string array of provider names", async () => {
    const ctx = makeCtx();
    const result = await modelsListProvidersFunction.execute({}, ctx);

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain("anthropic");
    expect(result.every((p) => typeof p === "string")).toBe(true);
  });
});

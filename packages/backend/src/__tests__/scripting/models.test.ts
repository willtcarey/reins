/* eslint-disable @typescript-eslint/consistent-type-assertions -- execute() returns unknown; tests need type access */

/**
 * Tests for the models scripting API functions.
 */

import { describe, test, expect } from "bun:test";
import { useTestDb } from "../helpers/test-db.js";
import { createTestState } from "../helpers/test-state.js";
import { setSetting } from "../../settings-store.js";
import { buildProviderList, MODEL_FUNCTIONS, type ProviderInfo } from "../../scripting/models.js";
import type { ApiContext } from "../../scripting/api-registry.js";
import type { ManagedSession } from "../../state.js";

function noop() {}

function makeCtx(overrides?: Partial<ApiContext>): ApiContext {
  const state = createTestState();
  return {
    projectId: 1,
    sessionId: "test-session",
    taskId: null,
    broadcast: noop,
    sessions: new Map<string, ManagedSession>(),
    encryptionSecret: state.encryptionSecret,
    ...overrides,
  };
}

describe("models.list", () => {
  useTestDb();

  const listFn = MODEL_FUNCTIONS.find((f) => f.name === "models.list")!;

  test("returns expected shape", () => {
    const ctx = makeCtx();
    const result = listFn.execute({}, ctx) as ProviderInfo[];

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);

    const first = result[0];
    expect(first).toHaveProperty("provider");
    expect(first).toHaveProperty("hasKey");
    expect(first).toHaveProperty("keySource");
    expect(first).toHaveProperty("models");
    expect(Array.isArray(first.models)).toBe(true);
  });

  test("includes anthropic provider with models", () => {
    const ctx = makeCtx();
    const result = listFn.execute({}, ctx) as ProviderInfo[];

    const anthropic = result.find((p) => p.provider === "anthropic");
    expect(anthropic).toBeDefined();
    expect(anthropic!.models.length).toBeGreaterThan(0);

    // Check model structure
    const model = anthropic!.models[0];
    expect(model).toHaveProperty("id");
    expect(model).toHaveProperty("name");
    expect(model).toHaveProperty("reasoning");
    expect(model).toHaveProperty("contextWindow");
    expect(model).toHaveProperty("maxTokens");
  });

  test("reflects DB-configured keys", () => {
    const ctx = makeCtx();

    // Set a DB key for anthropic
    setSetting("api_key_anthropic", "sk-test-key", ctx.encryptionSecret);

    const result = listFn.execute({}, ctx) as ProviderInfo[];
    const anthropic = result.find((p) => p.provider === "anthropic");
    expect(anthropic!.hasKey).toBe(true);
    expect(anthropic!.keySource).toBe("db");
  });
});

describe("buildProviderList", () => {
  useTestDb();

  test("returns same shape as models.list", () => {
    const state = createTestState();
    const result = buildProviderList(state.encryptionSecret);

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);

    const anthropic = result.find((p) => p.provider === "anthropic");
    expect(anthropic).toBeDefined();
  });
});

describe("models.listProviders", () => {
  const listProvidersFn = MODEL_FUNCTIONS.find((f) => f.name === "models.listProviders")!;

  test("returns string array of provider names", () => {
    const ctx = makeCtx();
    const result = listProvidersFn.execute({}, ctx) as string[];

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain("anthropic");
    expect(result.every((p) => typeof p === "string")).toBe(true);
  });
});

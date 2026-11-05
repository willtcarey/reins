/**
 * Tests for api.models.
 */

import { describe, test, expect } from "bun:test";
import { useTestDb } from "../helpers/test-db.js";
import { createAppState } from "../helpers/app-state.js";
import { setApiKeyCredential } from "../../auth-credentials-store.js";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { buildApiObject } from "../../scripting/api-registry.js";
import { ProviderInfoSchema } from "../../sdk-host/models.js";
import { scriptContext } from "../helpers/script-context.js";

/** A script's `api.models`. */
function makeCtx() {
  const api = buildApiObject(scriptContext(createAppState()));
  return {
    list: async () => Value.Parse(Type.Array(ProviderInfoSchema), await api.models.list()),
    listProviders: async () => Value.Parse(Type.Array(Type.String()), await api.models.listProviders()),
  };
}

describe("models.list", () => {
  useTestDb();

  test("returns expected shape", async () => {
    const ctx = makeCtx();
    const result = await ctx.list();

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);

    const first = result[0];
    expect(first).toHaveProperty("runtimeType");
    expect(first).toHaveProperty("provider");
    expect(first).toHaveProperty("isAvailable");
    expect(first).toHaveProperty("availabilitySource");
    expect(first).toHaveProperty("models");
    expect(Array.isArray(first.models)).toBe(true);
  });

  test("includes anthropic provider with models", async () => {
    const ctx = makeCtx();
    const result = await ctx.list();

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

    const result = await ctx.list();
    const anthropic = result.find((p) => p.runtimeType === "pi" && p.provider === "anthropic");
    expect(anthropic!.isAvailable).toBe(true);
    expect(anthropic!.availabilitySource).toBe("db");
  });

  test("does not advertise the inert Claude SDK runtime", async () => {
    const ctx = makeCtx();
    const result = await ctx.list();

    const claudeProvider = result.find((p) => p.runtimeType === "claude_agent_sdk" && p.provider === "claude_agent_sdk");
    expect(claudeProvider).toBeUndefined();
  });
});

describe("models.listProviders", () => {
  useTestDb();

  test("returns string array of provider names", async () => {
    const ctx = makeCtx();
    const result = await ctx.listProviders();

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain("anthropic");
    expect(result.every((p) => typeof p === "string")).toBe(true);
  });
});

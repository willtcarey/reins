import { describe, test, expect, beforeEach } from "bun:test";
import { useTestDb } from "../../helpers/test-db.js";
import { buildProviderList } from "../../../runtimes/pi/models-registry.js";
import { clearRuntimeAdapters } from "../../../runtimes/registry.js";
import { registerBuiltinRuntimeAdapters } from "../../../runtimes/register-builtins.js";

describe("buildProviderList", () => {
  useTestDb();

  beforeEach(() => {
    clearRuntimeAdapters();
    registerBuiltinRuntimeAdapters();
  });

  test("returns providers and models", async () => {
    const result = await buildProviderList();

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);

    const anthropic = result.find((p) => p.provider === "anthropic");
    expect(anthropic).toBeDefined();
  });
});

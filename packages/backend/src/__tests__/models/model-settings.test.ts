import { describe, test, expect } from "bun:test";
import { useTestDb } from "../helpers/test-db.js";
import { deleteSetting, setSetting } from "../../settings-store.js";
import {
  THINKING_LEVEL_VALUES,
  parseThinkingLevel,
  resolveModelSetting,
  resolveUtilityModel,
} from "../../models/model-settings.js";

describe("model settings resolution", () => {
  useTestDb();

  test("resolves the configured default model from settings", () => {
    setSetting("default_model", {
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      runtimeType: "pi",
      thinkingLevel: "medium",
    });

    const model = resolveModelSetting("default_model");

    expect(model?.provider).toBe("anthropic");
    expect(model?.id).toBe("claude-sonnet-4-20250514");
  });

  test("returns undefined when no default model is configured", () => {
    deleteSetting("default_model");

    expect(resolveModelSetting("default_model")).toBeUndefined();
  });

  test("parses valid thinking levels", () => {
    for (const level of THINKING_LEVEL_VALUES) {
      expect(parseThinkingLevel(level)).toBe(level);
    }
  });

  test("rejects invalid thinking levels", () => {
    expect(() => parseThinkingLevel("off")).toThrow(/Invalid thinking level/);
  });

  test("ignores REINS_PROVIDER/REINS_MODEL env vars when no default model is configured", () => {
    deleteSetting("default_model");

    const prevProvider = process.env.REINS_PROVIDER;
    const prevModel = process.env.REINS_MODEL;

    try {
      process.env.REINS_PROVIDER = "anthropic";
      process.env.REINS_MODEL = "claude-sonnet-4-20250514";

      expect(resolveModelSetting("default_model")).toBeUndefined();
    } finally {
      if (prevProvider === undefined) delete process.env.REINS_PROVIDER;
      else process.env.REINS_PROVIDER = prevProvider;

      if (prevModel === undefined) delete process.env.REINS_MODEL;
      else process.env.REINS_MODEL = prevModel;
    }
  });

  test("resolves utility_model when configured", () => {
    setSetting("utility_model", {
      provider: "anthropic",
      modelId: "claude-haiku-4-5",
      runtimeType: "pi",
      thinkingLevel: "minimal",
    });

    const model = resolveModelSetting("utility_model");

    expect(model?.provider).toBe("anthropic");
    expect(model?.id).toBe("claude-haiku-4-5");
  });

  test("throws when a configured utility model cannot be resolved", () => {
    setSetting("utility_model", {
      provider: "anthropic",
      modelId: "does-not-exist",
      runtimeType: "pi",
      thinkingLevel: "minimal",
    });

    expect(() => resolveModelSetting("utility_model")).toThrow(/Configured utility_model is invalid/);
  });

  test("utility model falls back to default_model when unset", () => {
    deleteSetting("utility_model");
    setSetting("default_model", {
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      runtimeType: "pi",
      thinkingLevel: "high",
    });

    const model = resolveUtilityModel();

    expect(model?.provider).toBe("anthropic");
    expect(model?.id).toBe("claude-sonnet-4-20250514");
  });
});

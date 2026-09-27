import { describe, test, expect, beforeEach } from "bun:test";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { useTestDb } from "../helpers/test-db.js";
import { deleteSetting, setSetting } from "../../settings-store.js";
import { createPiModelRuntime } from "../../runtimes/pi/factory.js";
import {
  THINKING_LEVEL_VALUES,
  parseThinkingLevel,
  resolveModelSettingWithConfigInRuntime,
  resolveUtilityModelConfig,
} from "../../models/model-settings.js";

describe("model settings resolution", () => {
  useTestDb();
  let modelRuntime: ModelRuntime;
  beforeEach(async () => { modelRuntime = await createPiModelRuntime(); });
  const resolve = (key: "default_model" | "utility_model") => resolveModelSettingWithConfigInRuntime(key, modelRuntime)?.model;

  test("resolves the configured default model from settings", () => {
    setSetting("default_model", {
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
      runtimeType: "pi",
      thinkingLevel: "medium",
    });

    const model = resolve("default_model");

    expect(model?.provider).toBe("anthropic");
    expect(model?.id).toBe("claude-sonnet-4-5");
  });

  test("returns undefined when no default model is configured", () => {
    deleteSetting("default_model");

    expect(resolve("default_model")).toBeUndefined();
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
      process.env.REINS_MODEL = "claude-sonnet-4-5";

      expect(resolve("default_model")).toBeUndefined();
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

    const model = resolve("utility_model");

    expect(model?.provider).toBe("anthropic");
    expect(model?.id).toBe("claude-haiku-4-5");
  });

  test("throws when a configured model cannot be resolved", () => {
    setSetting("utility_model", { provider: "anthropic", modelId: "does-not-exist", runtimeType: "pi", thinkingLevel: "minimal" });
    expect(() => resolve("utility_model")).toThrow(/Configured utility_model is invalid/);
    setSetting("default_model", { provider: "anthropic", modelId: "does-not-exist", runtimeType: "pi", thinkingLevel: "medium" });
    expect(() => resolve("default_model")).toThrow(/Configured default_model is invalid/);
  });

  test("rejects model settings for another runtime", () => {
    setSetting("default_model", {
      provider: "claude_agent_sdk",
      modelId: "claude-sonnet-4-6",
      runtimeType: "claude_agent_sdk",
      thinkingLevel: "medium",
    });
    expect(() => resolve("default_model")).toThrow("unavailable runtime 'claude_agent_sdk'");
    expect(() => resolveUtilityModelConfig()).toThrow("Configured utility model uses unavailable runtime 'claude_agent_sdk'");
  });

  test("the utility model setting falls back to default_model when unset", () => {
    deleteSetting("utility_model");
    const setting = { provider: "anthropic", modelId: "claude-sonnet-4-5", runtimeType: "pi", thinkingLevel: "high" } as const;
    setSetting("default_model", setting);

    expect(resolveUtilityModelConfig()).toEqual(setting);
  });
});

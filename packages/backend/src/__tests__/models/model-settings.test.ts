import { describe, test, expect } from "bun:test";
import { useTestDb } from "../helpers/test-db.js";
import { deleteSetting, setSetting } from "../../settings-store.js";
import {
  THINKING_LEVEL_VALUES,
  parseThinkingLevel,
  resolveUtilityModelConfig,
} from "../../models/model-settings.js";

describe("model settings resolution", () => {
  useTestDb();

  test("parses valid thinking levels", () => {
    for (const level of THINKING_LEVEL_VALUES) {
      expect(parseThinkingLevel(level)).toBe(level);
    }
  });

  test("rejects invalid thinking levels", () => {
    expect(() => parseThinkingLevel("off")).toThrow(/Invalid thinking level/);
  });

  test("the utility model setting wins over default_model", () => {
    const utility = { provider: "anthropic", modelId: "claude-haiku-4-5", runtimeType: "pi", thinkingLevel: "minimal" } as const;
    setSetting("default_model", { provider: "anthropic", modelId: "claude-sonnet-4-5", runtimeType: "pi", thinkingLevel: "high" });
    setSetting("utility_model", utility);

    expect(resolveUtilityModelConfig()).toEqual(utility);
  });

  test("the utility model setting falls back to default_model when unset", () => {
    deleteSetting("utility_model");
    const setting = { provider: "anthropic", modelId: "claude-sonnet-4-5", runtimeType: "pi", thinkingLevel: "high" } as const;
    setSetting("default_model", setting);

    expect(resolveUtilityModelConfig()).toEqual(setting);
  });

  test("rejects a utility model setting for another runtime", () => {
    setSetting("default_model", {
      provider: "claude_agent_sdk",
      modelId: "claude-sonnet-4-6",
      runtimeType: "claude_agent_sdk",
      thinkingLevel: "medium",
    });
    expect(() => resolveUtilityModelConfig()).toThrow("Configured utility model uses unavailable runtime 'claude_agent_sdk'");
  });
});

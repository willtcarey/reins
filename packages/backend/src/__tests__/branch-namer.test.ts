import { describe, test, expect, beforeEach, mock } from "bun:test";
import { generateBranchName, slugifyBranchName } from "../branch-namer.js";
import { clearRuntimeAdapters, registerRuntimeAdapter } from "../runtimes/registry.js";
import { deleteSetting, setSetting } from "../settings-store.js";
import { useTestDb } from "./helpers/test-db.js";

describe("generateBranchName", () => {
  useTestDb();

  beforeEach(() => {
    clearRuntimeAdapters();
    deleteSetting("utility_model");
    deleteSetting("default_model");
  });

  test("uses the configured utility model runtime for branch generation", async () => {
    const piAsk = mock(async () => "task/wrong-runtime");
    const claudeAsk = mock(async () => '"task/from-claude-runtime"');

    registerRuntimeAdapter({
      runtimeType: "pi",
      listModels: async () => [],
      ask: piAsk,
      createRuntime: async () => {
        throw new Error("not used");
      },
    });

    registerRuntimeAdapter({
      runtimeType: "claude_agent_sdk",
      listModels: async () => [],
      ask: claudeAsk,
      createRuntime: async () => {
        throw new Error("not used");
      },
    });

    setSetting("default_model", {
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      runtimeType: "pi",
      thinkingLevel: "medium",
    });
    setSetting("utility_model", {
      provider: "anthropic",
      modelId: "claude-haiku-4-5",
      runtimeType: "claude_agent_sdk",
      thinkingLevel: "minimal",
    });

    await expect(generateBranchName("Add dark mode support")).resolves.toBe("task/from-claude-runtime");

    expect(claudeAsk).toHaveBeenCalledTimes(1);
    expect(claudeAsk).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "Add dark mode support",
      cwd: process.cwd(),
      model: {
        provider: "anthropic",
        modelId: "claude-haiku-4-5",
      },
      thinkingLevel: "minimal",
    }));
    expect(piAsk).not.toHaveBeenCalled();
  });

  test("falls back to default model runtime when utility model is unset", async () => {
    const ask = mock(async () => "task/from-default-runtime");

    registerRuntimeAdapter({
      runtimeType: "claude_agent_sdk",
      listModels: async () => [],
      ask,
      createRuntime: async () => {
        throw new Error("not used");
      },
    });

    setSetting("default_model", {
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      runtimeType: "claude_agent_sdk",
      thinkingLevel: "medium",
    });

    await expect(generateBranchName("Add dark mode support")).resolves.toBe("task/from-default-runtime");

    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({
      model: {
        provider: "anthropic",
        modelId: "claude-sonnet-4-20250514",
      },
      thinkingLevel: "medium",
    }));
  });

  test("falls back to slugify when runtime adapter returns invalid output", async () => {
    registerRuntimeAdapter({
      runtimeType: "pi",
      listModels: async () => [],
      ask: async () => "not-a-valid-branch",
      createRuntime: async () => {
        throw new Error("not used");
      },
    });

    await expect(generateBranchName("Add dark mode support")).resolves.toBe("task/add-dark-mode-support");
  });
});

describe("slugifyBranchName", () => {
  test("converts a normal title to task/<slug>", () => {
    expect(slugifyBranchName("Add dark mode support")).toBe("task/add-dark-mode-support");
  });

  test("strips special characters", () => {
    expect(slugifyBranchName("Fix bug #123: crash on start!")).toBe("task/fix-bug-123-crash-on-start");
  });

  test("handles already-hyphenated input", () => {
    expect(slugifyBranchName("my-cool-feature")).toBe("task/my-cool-feature");
  });

  test("collapses multiple spaces and hyphens", () => {
    expect(slugifyBranchName("too   many   spaces")).toBe("task/too-many-spaces");
    expect(slugifyBranchName("too---many---hyphens")).toBe("task/too-many-hyphens");
  });

  test("caps length at 50 chars (slug portion)", () => {
    const longTitle = "this is a very long task title that should be truncated to fifty characters";
    const result = slugifyBranchName(longTitle);
    const slug = result.replace("task/", "");
    expect(slug.length).toBeLessThanOrEqual(50);
    expect(slug).not.toMatch(/-$/);
  });

  test("returns task/untitled for empty string", () => {
    expect(slugifyBranchName("")).toBe("task/untitled");
  });

  test("returns task/untitled for whitespace-only", () => {
    expect(slugifyBranchName("   ")).toBe("task/untitled");
  });

  test("returns task/untitled for special-chars-only", () => {
    expect(slugifyBranchName("!@#$%^&*()")).toBe("task/untitled");
  });

  test("strips unicode characters", () => {
    expect(slugifyBranchName("café résumé")).toBe("task/caf-rsum");
  });

  test("converts to lowercase", () => {
    expect(slugifyBranchName("FIX ALL THE THINGS")).toBe("task/fix-all-the-things");
  });

  test("strips leading and trailing hyphens from slug", () => {
    expect(slugifyBranchName("-leading and trailing-")).toBe("task/leading-and-trailing");
  });
});

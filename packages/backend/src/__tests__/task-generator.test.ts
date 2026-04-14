import { describe, test, expect, beforeEach, mock } from "bun:test";
import { generateTask } from "../task-generator.js";
import { clearRuntimeAdapters, registerRuntimeAdapter } from "../runtimes/registry.js";
import { deleteSetting, setSetting } from "../settings-store.js";
import { useTestDb } from "./helpers/test-db.js";

describe("generateTask", () => {
  useTestDb();

  beforeEach(() => {
    clearRuntimeAdapters();
    deleteSetting("utility_model");
    deleteSetting("default_model");
  });

  test("uses the configured utility model runtime for task generation", async () => {
    const piAsk = mock(async () => JSON.stringify({
      title: "Wrong runtime",
      description: "Should not be used.",
      branch_name: "task/wrong-runtime",
    }));
    const claudeAsk = mock(async () => JSON.stringify({
      title: "Add dark mode support",
      description: "Implement theme toggling in settings and UI.",
      branch_name: "task/add-dark-mode-support",
    }));

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

    await expect(generateTask("add dark mode")).resolves.toEqual({
      title: "Add dark mode support",
      description: "Implement theme toggling in settings and UI.",
      branch_name: "task/add-dark-mode-support",
    });

    expect(claudeAsk).toHaveBeenCalledTimes(1);
    expect(claudeAsk).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "add dark mode",
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
    const ask = mock(async () => JSON.stringify({
      title: "Add dark mode support",
      description: "Implement theme toggling in settings and UI.",
      branch_name: "task/add-dark-mode-support",
    }));

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

    await expect(generateTask("add dark mode")).resolves.toEqual({
      title: "Add dark mode support",
      description: "Implement theme toggling in settings and UI.",
      branch_name: "task/add-dark-mode-support",
    });

    expect(ask).toHaveBeenCalledTimes(1);
  });

  test("falls back when the configured adapter.ask throws", async () => {
    registerRuntimeAdapter({
      runtimeType: "claude_agent_sdk",
      listModels: async () => [],
      ask: async () => {
        throw new Error("boom");
      },
      createRuntime: async () => {
        throw new Error("not used");
      },
    });

    setSetting("utility_model", {
      provider: "anthropic",
      modelId: "claude-haiku-4-5",
      runtimeType: "claude_agent_sdk",
      thinkingLevel: "minimal",
    });

    await expect(generateTask("add dark mode support")).resolves.toEqual({
      title: "add dark mode support",
      description: "add dark mode support",
      branch_name: "task/add-dark-mode-support",
    });
  });
});

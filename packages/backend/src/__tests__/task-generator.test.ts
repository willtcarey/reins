import { describe, test, expect, beforeEach } from "bun:test";
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

  test("rejects an inert utility runtime instead of falling back", async () => {
    setSetting("utility_model", {
      provider: "anthropic", modelId: "claude-haiku-4-5",
      runtimeType: "claude_agent_sdk", thinkingLevel: "minimal",
    });
    await expect(generateTask("add dark mode"))
      .rejects.toThrow("Configured utility model uses unavailable runtime 'claude_agent_sdk'");
  });

  test("rejects an inert default utility runtime when no utility override exists", async () => {
    setSetting("default_model", {
      provider: "anthropic", modelId: "claude-sonnet-4-5",
      runtimeType: "claude_agent_sdk", thinkingLevel: "medium",
    });
    await expect(generateTask("add dark mode"))
      .rejects.toThrow("Configured utility model uses unavailable runtime 'claude_agent_sdk'");
  });

  test("falls back when the configured adapter.ask throws", async () => {
    registerRuntimeAdapter({
      runtimeType: "pi",
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
      runtimeType: "pi",
      thinkingLevel: "minimal",
    });

    await expect(generateTask("add dark mode support")).resolves.toEqual({
      title: "add dark mode support",
      description: "add dark mode support",
      branch_name: "task/add-dark-mode-support",
    });
  });
});

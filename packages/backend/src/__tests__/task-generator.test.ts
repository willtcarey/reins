import { describe, test, expect, beforeEach, mock } from "bun:test";
import { generateTask } from "../task-generator.js";
import { clearRuntimeAdapters, registerRuntimeAdapter } from "../runtimes/registry.js";

describe("generateTask", () => {
  beforeEach(() => {
    clearRuntimeAdapters();
  });

  test("uses adapter.ask and parses returned JSON", async () => {
    const ask = mock(async () => JSON.stringify({
      title: "Add dark mode support",
      description: "Implement theme toggling in settings and UI.",
      branch_name: "task/add-dark-mode-support",
    }));

    registerRuntimeAdapter({
      runtimeType: "pi",
      listModels: async () => [],
      ask,
      createRuntime: async () => {
        throw new Error("not used");
      },
    });

    await expect(generateTask("add dark mode")).resolves.toEqual({
      title: "Add dark mode support",
      description: "Implement theme toggling in settings and UI.",
      branch_name: "task/add-dark-mode-support",
    });

    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "add dark mode",
      cwd: process.cwd(),
    }));
  });

  test("falls back when adapter.ask throws", async () => {
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

    await expect(generateTask("add dark mode support")).resolves.toEqual({
      title: "add dark mode support",
      description: "add dark mode support",
      branch_name: "task/add-dark-mode-support",
    });
  });
});

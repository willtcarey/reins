import { describe, test, expect } from "bun:test";
import {
  decodeModelSelection,
  encodeModelSelection,
  findModelInfo,
  formatModelSelectionOptionLabel,
  formatModelSettingLabel,
  providerLabel,
} from "../models/settings.js";

describe("settings helpers", () => {
  const providers = [
    {
      runtimeType: "pi",
      provider: "anthropic",
      isAvailable: true,
      availabilitySource: "db" as const,
      availabilitySources: ["db" as const],
      models: [
        { id: "shared-model", name: "Claude Sonnet 4", reasoning: true },
        { id: "unique-model", name: "Claude Haiku 4.5", reasoning: true },
      ],
    },
    {
      runtimeType: "pi",
      provider: "openai",
      isAvailable: true,
      availabilitySource: "db" as const,
      availabilitySources: ["db" as const],
      models: [
        { id: "shared-model", name: "GPT Shared", reasoning: false },
      ],
    },
  ];

  test("providerLabel prettifies provider slugs", () => {
    expect(providerLabel("openai")).toBe("Openai");
    expect(providerLabel("open-router")).toBe("Open Router");
  });

  test("model selection encoding round-trips runtime, provider, and model", () => {
    const value = encodeModelSelection("pi", "anthropic", "claude-sonnet-4");
    expect(decodeModelSelection(value)).toEqual({
      runtimeType: "pi",
      provider: "anthropic",
      modelId: "claude-sonnet-4",
    });
  });

  test("model option labels include both provider and model", () => {
    expect(formatModelSelectionOptionLabel("anthropic", "Claude Sonnet 4")).toBe("Anthropic / Claude Sonnet 4");
  });

  test("findModelInfo returns the resolved model metadata", () => {
    expect(findModelInfo(providers, "anthropic", "unique-model")?.name).toBe("Claude Haiku 4.5");
    expect(findModelInfo(providers, "anthropic", "missing-model")).toBeNull();
  });

  test("formatModelSettingLabel omits provider when model id is unambiguous", () => {
    expect(formatModelSettingLabel({
      providers,
      model: {
        provider: "anthropic",
        modelId: "unique-model",
        runtimeType: "pi",
        thinkingLevel: "high",
      },
    })).toBe("Claude Haiku 4.5 · High");
  });

  test("formatModelSettingLabel includes provider when model id is ambiguous", () => {
    expect(formatModelSettingLabel({
      providers,
      model: {
        provider: "anthropic",
        modelId: "shared-model",
        runtimeType: "pi",
        thinkingLevel: "high",
      },
    })).toBe("Anthropic / Claude Sonnet 4 · High");
  });

  test("formatModelSettingLabel always includes thinking level", () => {
    expect(formatModelSettingLabel({
      providers,
      model: {
        provider: "anthropic",
        modelId: "unique-model",
        runtimeType: "pi",
        thinkingLevel: "minimal",
      },
    })).toBe("Claude Haiku 4.5 · Minimal");
  });
});

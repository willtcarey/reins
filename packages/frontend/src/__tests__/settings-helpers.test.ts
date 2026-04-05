import { describe, test, expect } from "bun:test";
import {
  decodeDefaultModelSelection,
  encodeDefaultModelSelection,
  formatDefaultModelOptionLabel,
  providerLabel,
} from "../models/settings.js";

describe("settings helpers", () => {
  test("providerLabel prettifies provider slugs", () => {
    expect(providerLabel("openai")).toBe("Openai");
    expect(providerLabel("open-router")).toBe("Open Router");
  });

  test("default model selection encoding round-trips provider and model", () => {
    const value = encodeDefaultModelSelection("anthropic", "claude-sonnet-4");
    expect(decodeDefaultModelSelection(value)).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4",
    });
  });

  test("default model option labels include both provider and model", () => {
    expect(formatDefaultModelOptionLabel("anthropic", "Claude Sonnet 4")).toBe("Anthropic / Claude Sonnet 4");
  });
});

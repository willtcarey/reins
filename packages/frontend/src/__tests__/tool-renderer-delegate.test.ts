import { describe, test, expect } from "bun:test";
import { getDelegateSummary, getDelegateDetail } from "../models/tools/delegate.js";
import type { ToolBlockData } from "../models/chat-state.js";

function makeDelegateBlock(overrides: Partial<ToolBlockData> = {}): ToolBlockData {
  return {
    id: "delegate-test-id",
    name: "delegate",
    args: { prompt: "Refactor the authentication module to use JWT tokens instead of session cookies" },
    status: "done",
    ...overrides,
  };
}

describe("delegate tool model helpers", () => {
  test("uses a truncated prompt for the summary while retaining full detail", () => {
    const longPrompt = "x".repeat(200);
    const block = makeDelegateBlock({ args: { prompt: longPrompt } });

    expect(getDelegateSummary(block)).toBe("x".repeat(80) + "…");
    expect(getDelegateDetail(block)).toEqual({ prompt: longPrompt });
  });

  test("uses empty strings when prompt args are missing", () => {
    expect(getDelegateSummary(makeDelegateBlock({ args: {} }))).toBe("");
    expect(getDelegateSummary(makeDelegateBlock({ args: undefined }))).toBe("");
    expect(getDelegateDetail(makeDelegateBlock({ args: undefined }))).toEqual({ prompt: "" });
  });
});

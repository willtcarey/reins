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

describe("getDelegateSummary", () => {
  test("returns truncated prompt (first ~80 chars)", () => {
    const block = makeDelegateBlock();
    const summary = getDelegateSummary(block);
    expect(summary.length).toBeLessThanOrEqual(83); // 80 + "…"
    expect(summary).toBe("Refactor the authentication module to use JWT tokens instead of session cookies");
  });

  test("truncates long prompts", () => {
    const longPrompt = "x".repeat(200);
    const block = makeDelegateBlock({ args: { prompt: longPrompt } });
    const summary = getDelegateSummary(block);
    expect(summary.length).toBeLessThanOrEqual(83);
    expect(summary).toBe("x".repeat(80) + "…");
  });

  test("returns empty string when args has no prompt", () => {
    expect(getDelegateSummary(makeDelegateBlock({ args: {} }))).toBe("");
  });

  test("returns empty string when args is undefined", () => {
    expect(getDelegateSummary(makeDelegateBlock({ args: undefined }))).toBe("");
  });

  test("short prompts are not truncated", () => {
    const block = makeDelegateBlock({ args: { prompt: "Fix the bug" } });
    expect(getDelegateSummary(block)).toBe("Fix the bug");
  });
});

describe("getDelegateDetail", () => {
  test("returns full prompt text", () => {
    const detail = getDelegateDetail(makeDelegateBlock());
    expect(detail.prompt).toBe("Refactor the authentication module to use JWT tokens instead of session cookies");
  });

  test("returns empty string when args has no prompt", () => {
    expect(getDelegateDetail(makeDelegateBlock({ args: {} }))).toEqual({ prompt: "" });
  });

  test("returns empty string when args is undefined", () => {
    expect(getDelegateDetail(makeDelegateBlock({ args: undefined }))).toEqual({ prompt: "" });
  });
});

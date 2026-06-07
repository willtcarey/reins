import { describe, test, expect } from "bun:test";
import { getBashCommand, getBashPreview, getBashOutput, getBashExitInfo } from "../models/tools/bash.js";
import type { ToolBlockData } from "../models/chat-state.js";

function makeBashBlock(overrides: Partial<ToolBlockData> = {}): ToolBlockData {
  return {
    id: "bash-test-id",
    name: "Bash",
    args: { command: "ls -la" },
    status: "done",
    ...overrides,
  };
}

function makeBashResult(text: string): ToolBlockData["result"] {
  return { content: [{ type: "text", text }] };
}

describe("Bash tool model helpers", () => {
  test("extracts the command while tolerating missing args", () => {
    expect(getBashCommand(makeBashBlock())).toBe("ls -la");
    expect(getBashCommand(makeBashBlock({ args: {} }))).toBe("");
    expect(getBashCommand(makeBashBlock({ args: undefined }))).toBe("");
  });

  test("builds a compact preview from the first non-empty output line", () => {
    const block = makeBashBlock({ result: makeBashResult("\n\n  " + "x".repeat(20) + "\nsecond line") });

    expect(getBashPreview(block, 8)).toBe("xxxxxxx…");
    expect(getBashPreview(makeBashBlock({ result: undefined }))).toBe("");
  });

  test("joins full text output across result blocks", () => {
    const block = makeBashBlock({
      result: {
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
      },
    });

    expect(getBashOutput(block)).toBe("first\nsecond");
    expect(getBashOutput(makeBashBlock({ result: undefined }))).toBe("");
  });

  test("reports running, error, and successful exit states", () => {
    expect(getBashExitInfo(makeBashBlock({ status: "running" }))).toEqual({ isError: false, label: "running" });
    expect(getBashExitInfo(makeBashBlock({ status: "done", isError: true }))).toEqual({ isError: true, label: "error" });
    expect(getBashExitInfo(makeBashBlock({ status: "done", isError: false }))).toEqual({ isError: false, label: "ok" });
  });
});

import { describe, test, expect } from "bun:test";
import { getBashCommand, getBashPreview, getBashOutput, getBashExitInfo } from "../models/tools/bash.js";
import type { ToolBlockData } from "../chat-state.js";

function makeBashBlock(overrides: Partial<ToolBlockData> = {}): ToolBlockData {
  return {
    type: "tool",
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

describe("getBashCommand", () => {
  test("returns the command from args", () => {
    expect(getBashCommand(makeBashBlock())).toBe("ls -la");
  });

  test("returns empty string when args has no command", () => {
    expect(getBashCommand(makeBashBlock({ args: {} }))).toBe("");
  });

  test("returns empty string when args is undefined", () => {
    expect(getBashCommand(makeBashBlock({ args: undefined as any }))).toBe("");
  });

  test("returns full long commands without truncation", () => {
    const longCmd = "x".repeat(200);
    const result = getBashCommand(makeBashBlock({ args: { command: longCmd } }));
    expect(result).toBe(longCmd);
  });

  test("returns full multi-line commands", () => {
    const cmd = "echo hello\necho world";
    const result = getBashCommand(makeBashBlock({ args: { command: cmd } }));
    expect(result).toBe("echo hello\necho world");
  });

  test("single-line short command is returned as-is", () => {
    expect(getBashCommand(makeBashBlock({ args: { command: "pwd" } }))).toBe("pwd");
  });
});

describe("getBashPreview", () => {
  test("returns first line of output", () => {
    const block = makeBashBlock({ result: makeBashResult("line one\nline two\nline three") });
    expect(getBashPreview(block)).toBe("line one");
  });

  test("returns empty string when no result", () => {
    expect(getBashPreview(makeBashBlock({ result: undefined }))).toBe("");
  });

  test("returns empty string when result text is empty", () => {
    expect(getBashPreview(makeBashBlock({ result: makeBashResult("") }))).toBe("");
  });

  test("trims leading blank lines from output", () => {
    const block = makeBashBlock({ result: makeBashResult("\n\n  actual output\nmore") });
    expect(getBashPreview(block)).toBe("actual output");
  });

  test("truncates long first lines", () => {
    const longLine = "x".repeat(200);
    const block = makeBashBlock({ result: makeBashResult(longLine) });
    const preview = getBashPreview(block);
    expect(preview.length).toBeLessThanOrEqual(120);
    expect(preview).toBe("x".repeat(119) + "…");
  });

  test("returns single-line output as-is", () => {
    const block = makeBashBlock({ result: makeBashResult("hello world") });
    expect(getBashPreview(block)).toBe("hello world");
  });
});

describe("getBashOutput", () => {
  test("returns full output text", () => {
    const block = makeBashBlock({ result: makeBashResult("line one\nline two\nline three") });
    expect(getBashOutput(block)).toBe("line one\nline two\nline three");
  });

  test("returns empty string when no result", () => {
    expect(getBashOutput(makeBashBlock({ result: undefined }))).toBe("");
  });

  test("returns empty string when result text is empty", () => {
    expect(getBashOutput(makeBashBlock({ result: makeBashResult("") }))).toBe("");
  });

  test("joins multiple text content blocks", () => {
    const block = makeBashBlock({
      result: {
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
      },
    });
    expect(getBashOutput(block)).toBe("first\nsecond");
  });
});

describe("getBashExitInfo", () => {
  test("returns running for running blocks", () => {
    const block = makeBashBlock({ status: "running" });
    expect(getBashExitInfo(block)).toEqual({ isError: false, label: "running" });
  });

  test("returns error for error blocks", () => {
    const block = makeBashBlock({ status: "done", isError: true });
    expect(getBashExitInfo(block)).toEqual({ isError: true, label: "error" });
  });

  test("returns ok for successful blocks", () => {
    const block = makeBashBlock({ status: "done", isError: false });
    expect(getBashExitInfo(block)).toEqual({ isError: false, label: "ok" });
  });

  test("returns ok when isError is undefined", () => {
    const block = makeBashBlock({ status: "done" });
    expect(getBashExitInfo(block)).toEqual({ isError: false, label: "ok" });
  });
});

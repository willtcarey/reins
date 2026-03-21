import { describe, test, expect } from "bun:test";
import { getWriteSummary, getWriteInfo } from "../models/tools/write.js";
import type { ToolBlockData } from "../models/chat-state.js";

function makeWriteBlock(overrides: Partial<ToolBlockData> = {}): ToolBlockData {
  return {
    type: "tool",
    id: "write-test-id",
    name: "Write",
    args: { path: "src/new-file.ts", content: "line1\nline2\nline3" },
    status: "done",
    ...overrides,
  };
}

describe("getWriteSummary", () => {
  test("returns the file path from args", () => {
    expect(getWriteSummary(makeWriteBlock())).toBe("src/new-file.ts");
  });

  test("returns empty string when args has no path", () => {
    expect(getWriteSummary(makeWriteBlock({ args: {} }))).toBe("");
  });

  test("returns empty string when args is undefined", () => {
    expect(getWriteSummary(makeWriteBlock({ args: undefined as any }))).toBe("");
  });
});

describe("getWriteInfo", () => {
  test("returns line count of content", () => {
    expect(getWriteInfo(makeWriteBlock())).toEqual({ lines: 3 });
  });

  test("returns 1 for single-line content", () => {
    expect(getWriteInfo(makeWriteBlock({ args: { path: "f.ts", content: "hello" } }))).toEqual({ lines: 1 });
  });

  test("returns 0 for empty content", () => {
    expect(getWriteInfo(makeWriteBlock({ args: { path: "f.ts", content: "" } }))).toEqual({ lines: 0 });
  });

  test("returns 0 when content is missing", () => {
    expect(getWriteInfo(makeWriteBlock({ args: { path: "f.ts" } }))).toEqual({ lines: 0 });
  });

  test("returns 0 when args is undefined", () => {
    expect(getWriteInfo(makeWriteBlock({ args: undefined as any }))).toEqual({ lines: 0 });
  });
});

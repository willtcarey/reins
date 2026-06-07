import { describe, test, expect } from "bun:test";
import { getReadSummary, getReadPreview, getReadContent, getReadLineCount, getReadRange, getReadTrailer } from "../models/tools/read.js";
import type { ToolBlockData } from "../models/chat-state.js";

function makeReadBlock(overrides: Partial<ToolBlockData> = {}): ToolBlockData {
  return {
    id: "read-test-id",
    name: "Read",
    args: { path: "src/index.ts" },
    status: "done",
    ...overrides,
  };
}

function makeReadResult(text: string): ToolBlockData["result"] {
  return { content: [{ type: "text", text }] };
}

describe("Read tool model helpers", () => {
  test("extracts path and requested range labels", () => {
    expect(getReadSummary(makeReadBlock())).toBe("src/index.ts");
    expect(getReadSummary(makeReadBlock({ args: undefined }))).toBe("");

    expect(getReadRange(makeReadBlock())).toBe("");
    expect(getReadRange(makeReadBlock({ args: { path: "f.ts", offset: 10, limit: 20 } }))).toBe("L10–29");
    expect(getReadRange(makeReadBlock({ args: { path: "f.ts", offset: 50 } }))).toBe("L50+");
    expect(getReadRange(makeReadBlock({ args: { path: "f.ts", limit: 25 } }))).toBe("25 lines");
  });

  test("builds preview text by stripping line numbers, limiting lines, and truncating long lines", () => {
    const block = makeReadBlock({
      result: makeReadResult(`     1\tline one\n     2\t${"x".repeat(205)}\n     3\thidden`),
    });

    expect(getReadPreview(block)).toBe(`line one\n${"x".repeat(200)}…`);
  });

  test("extracts full content, line count, and trailer metadata", () => {
    const block = makeReadBlock({
      result: makeReadResult("     1\tline one\n     2\tline two\n\n[163 more lines in file. Use offset=51 to continue.]"),
    });

    expect(getReadContent(block)).toBe("line one\nline two");
    expect(getReadLineCount(block)).toBe(2);
    expect(getReadTrailer(block)).toBe("163 more lines in file. Use offset=51 to continue.");
  });

  test("returns empty display strings for missing or non-text results", () => {
    const imageOnly = makeReadBlock({ result: { content: [{ type: "image", data: "abc", mimeType: "image/png" }] } });

    expect(getReadPreview(makeReadBlock({ result: undefined }))).toBe("");
    expect(getReadContent(makeReadBlock({ result: undefined }))).toBe("");
    expect(getReadLineCount(makeReadBlock({ result: undefined }))).toBe(0);
    expect(getReadTrailer(makeReadBlock({ result: undefined }))).toBe("");
    expect(getReadPreview(imageOnly)).toBe("");
  });
});

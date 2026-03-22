import { describe, test, expect } from "bun:test";
import { getReadSummary, getReadPreview, getReadContent, getReadLineCount, getReadRange, getReadTrailer } from "../models/tools/read.js";
import type { ToolBlockData } from "../models/chat-state.js";

function makeToolBlock(overrides: Partial<ToolBlockData> = {}): ToolBlockData {
  return {
    id: "test-id",
    name: "Read",
    args: { path: "src/index.ts" },
    status: "done",
    ...overrides,
  };
}

function makeReadResult(text: string): ToolBlockData["result"] {
  return { content: [{ type: "text", text }] };
}

describe("getReadSummary", () => {
  test("returns the file path from args", () => {
    expect(getReadSummary(makeToolBlock())).toBe("src/index.ts");
  });

  test("returns empty string when args has no path", () => {
    expect(getReadSummary(makeToolBlock({ args: {} }))).toBe("");
  });

  test("returns empty string when args is undefined", () => {
    expect(getReadSummary(makeToolBlock({ args: undefined as any }))).toBe("");
  });
});

describe("getReadPreview", () => {
  test("returns first 2 lines of result text", () => {
    const block = makeToolBlock({
      result: makeReadResult("line one\nline two\nline three\nline four"),
    });
    expect(getReadPreview(block)).toBe("line one\nline two");
  });

  test("returns single line if result has only one line", () => {
    const block = makeToolBlock({
      result: makeReadResult("only line"),
    });
    expect(getReadPreview(block)).toBe("only line");
  });

  test("returns empty string when no result", () => {
    const block = makeToolBlock({ result: undefined });
    expect(getReadPreview(block)).toBe("");
  });

  test("returns empty string when result has no text content", () => {
    const block = makeToolBlock({
      result: { content: [{ type: "image" as any, data: "abc", mimeType: "image/png" }] },
    });
    expect(getReadPreview(block)).toBe("");
  });

  test("returns empty string when result text is empty", () => {
    const block = makeToolBlock({ result: makeReadResult("") });
    expect(getReadPreview(block)).toBe("");
  });

  test("truncates long lines to 200 chars", () => {
    const longLine = "x".repeat(300);
    const block = makeToolBlock({ result: makeReadResult(longLine) });
    const preview = getReadPreview(block);
    expect(preview.length).toBeLessThanOrEqual(203); // 200 + "…"
    expect(preview).toBe("x".repeat(200) + "…");
  });

  test("joins text from multiple text content blocks", () => {
    const block = makeToolBlock({
      result: {
        content: [
          { type: "text", text: "first block line 1\nfirst block line 2" },
          { type: "text", text: "second block line 1" },
        ],
      },
    });
    // Joined text: "first block line 1\nfirst block line 2\nsecond block line 1"
    // First 2 lines: "first block line 1\nfirst block line 2"
    expect(getReadPreview(block)).toBe("first block line 1\nfirst block line 2");
  });

  test("configurable maxLines", () => {
    const block = makeToolBlock({
      result: makeReadResult("a\nb\nc\nd"),
    });
    expect(getReadPreview(block, 3)).toBe("a\nb\nc");
  });
});

describe("getReadContent", () => {
  test("returns full content text", () => {
    const block = makeToolBlock({
      result: makeReadResult("line one\nline two\nline three"),
    });
    expect(getReadContent(block)).toBe("line one\nline two\nline three");
  });

  test("truncates to maxLen", () => {
    const block = makeToolBlock({
      result: makeReadResult("x".repeat(6000)),
    });
    expect(getReadContent(block)).toHaveLength(5000);
  });

  test("returns empty string when no result", () => {
    const block = makeToolBlock({ result: undefined });
    expect(getReadContent(block)).toBe("");
  });

  test("content excludes the trailing metadata line", () => {
    const block = makeToolBlock({
      result: makeReadResult("line one\nline two\n\n[163 more lines in file. Use offset=51 to continue.]"),
    });
    expect(getReadContent(block)).toBe("line one\nline two");
  });
});

describe("getReadLineCount", () => {
  test("returns line count of result text", () => {
    const block = makeToolBlock({
      result: makeReadResult("a\nb\nc\nd"),
    });
    expect(getReadLineCount(block)).toBe(4);
  });

  test("returns 1 for single line", () => {
    const block = makeToolBlock({
      result: makeReadResult("only line"),
    });
    expect(getReadLineCount(block)).toBe(1);
  });

  test("returns 0 when no result", () => {
    const block = makeToolBlock({ result: undefined });
    expect(getReadLineCount(block)).toBe(0);
  });

  test("returns 0 for empty text", () => {
    const block = makeToolBlock({ result: makeReadResult("") });
    expect(getReadLineCount(block)).toBe(0);
  });

  test("line count excludes the trailing metadata line", () => {
    const block = makeToolBlock({
      result: makeReadResult("a\nb\nc\n\n[50 more lines in file. Use offset=10 to continue.]"),
    });
    expect(getReadLineCount(block)).toBe(3);
  });
});

describe("getReadRange", () => {
  test("returns empty string when no offset or limit", () => {
    expect(getReadRange(makeToolBlock())).toBe("");
  });

  test("returns range with offset and limit", () => {
    expect(getReadRange(makeToolBlock({ args: { path: "f.ts", offset: 10, limit: 20 } }))).toBe("L10–29");
  });

  test("returns offset only", () => {
    expect(getReadRange(makeToolBlock({ args: { path: "f.ts", offset: 50 } }))).toBe("L50+");
  });

  test("returns limit only", () => {
    expect(getReadRange(makeToolBlock({ args: { path: "f.ts", limit: 25 } }))).toBe("25 lines");
  });
});

describe("getReadTrailer", () => {
  test("extracts trailer from result text", () => {
    const block = makeToolBlock({
      result: makeReadResult("line one\nline two\n\n[163 more lines in file. Use offset=51 to continue.]"),
    });
    expect(getReadTrailer(block)).toBe("163 more lines in file. Use offset=51 to continue.");
  });

  test("returns empty string when no trailer", () => {
    const block = makeToolBlock({
      result: makeReadResult("line one\nline two"),
    });
    expect(getReadTrailer(block)).toBe("");
  });

  test("returns empty string when no result", () => {
    expect(getReadTrailer(makeToolBlock({ result: undefined }))).toBe("");
  });
});

import { describe, test, expect } from "bun:test";
import { getEditSummary, getEditStats, computeEditDiff, parseDiffString, getEditDiffLines, shouldShowEditDiff, shouldAutoExpand, AUTO_EXPAND_THRESHOLD } from "../models/tools/edit.js";
import type { ToolBlockData } from "../chat-state.js";

function makeEditBlock(overrides: Partial<ToolBlockData> = {}): ToolBlockData {
  return {
    type: "tool",
    id: "edit-test-id",
    name: "Edit",
    args: { path: "src/app.ts", oldText: "foo", newText: "bar" },
    status: "done",
    ...overrides,
  };
}

describe("getEditSummary", () => {
  test("returns the file path from args", () => {
    expect(getEditSummary(makeEditBlock())).toBe("src/app.ts");
  });

  test("returns empty string when args has no path", () => {
    expect(getEditSummary(makeEditBlock({ args: {} }))).toBe("");
  });

  test("returns empty string when args is undefined", () => {
    expect(getEditSummary(makeEditBlock({ args: undefined as any }))).toBe("");
  });
});

describe("getEditStats", () => {
  test("counts additions and removals from oldText/newText", () => {
    const block = makeEditBlock({
      args: { path: "f.ts", oldText: "line1\nline2\nline3", newText: "line1\nchanged" },
    });
    expect(getEditStats(block)).toEqual({ additions: 2, removals: 3 });
  });

  test("addition only (empty oldText)", () => {
    const block = makeEditBlock({
      args: { path: "f.ts", oldText: "", newText: "new line" },
    });
    expect(getEditStats(block)).toEqual({ additions: 1, removals: 0 });
  });

  test("removal only (empty newText)", () => {
    const block = makeEditBlock({
      args: { path: "f.ts", oldText: "old line", newText: "" },
    });
    expect(getEditStats(block)).toEqual({ additions: 0, removals: 1 });
  });

  test("handles missing args gracefully", () => {
    expect(getEditStats(makeEditBlock({ args: undefined as any }))).toEqual({ additions: 0, removals: 0 });
    expect(getEditStats(makeEditBlock({ args: {} }))).toEqual({ additions: 0, removals: 0 });
  });

  test("handles both empty strings", () => {
    const block = makeEditBlock({
      args: { path: "f.ts", oldText: "", newText: "" },
    });
    expect(getEditStats(block)).toEqual({ additions: 0, removals: 0 });
  });

  test("multiline replacement", () => {
    const block = makeEditBlock({
      args: { path: "f.ts", oldText: "a\nb", newText: "c\nd\ne" },
    });
    expect(getEditStats(block)).toEqual({ additions: 3, removals: 2 });
  });

  test("computes stats from diff string when details available", () => {
    const block = makeEditBlock({
      result: {
        content: [{ type: "text" as const, text: "ok" }],
        details: {
          diff: [
            " 1 context",
            "-2 removed",
            "-3 removed2",
            "+2 added",
            " 4 context",
          ].join("\n"),
        },
      },
    });
    expect(getEditStats(block)).toEqual({ additions: 1, removals: 2 });
  });

  test("falls back to oldText/newText when no details", () => {
    const block = makeEditBlock({
      args: { path: "f.ts", oldText: "a\nb", newText: "c" },
    });
    expect(getEditStats(block)).toEqual({ additions: 1, removals: 2 });
  });
});

describe("computeEditDiff", () => {
  test("simple replacement: all old lines removed, all new lines added", () => {
    const diff = computeEditDiff("foo", "bar");
    expect(diff).toEqual([
      { type: "remove", text: "foo", oldLine: 1 },
      { type: "add", text: "bar", newLine: 1 },
    ]);
  });

  test("addition only (empty oldText)", () => {
    const diff = computeEditDiff("", "new line");
    expect(diff).toEqual([
      { type: "add", text: "new line", newLine: 1 },
    ]);
  });

  test("removal only (empty newText)", () => {
    const diff = computeEditDiff("old line", "");
    expect(diff).toEqual([
      { type: "remove", text: "old line", oldLine: 1 },
    ]);
  });

  test("both empty returns empty array", () => {
    expect(computeEditDiff("", "")).toEqual([]);
  });

  test("multiline replacement", () => {
    const diff = computeEditDiff("a\nb\nc", "x\ny");
    expect(diff).toEqual([
      { type: "remove", text: "a", oldLine: 1 },
      { type: "remove", text: "b", oldLine: 2 },
      { type: "remove", text: "c", oldLine: 3 },
      { type: "add", text: "x", newLine: 1 },
      { type: "add", text: "y", newLine: 2 },
    ]);
  });

  test("preserves empty lines in multiline text", () => {
    const diff = computeEditDiff("a\n\nb", "x");
    expect(diff).toEqual([
      { type: "remove", text: "a", oldLine: 1 },
      { type: "remove", text: "", oldLine: 2 },
      { type: "remove", text: "b", oldLine: 3 },
      { type: "add", text: "x", newLine: 1 },
    ]);
  });
});

describe("parseDiffString", () => {
  test("parses added lines", () => {
    const diff = "+1 added line";
    expect(parseDiffString(diff)).toEqual([
      { type: "add", text: "added line", newLine: 1 },
    ]);
  });

  test("parses removed lines", () => {
    const diff = "-1 removed line";
    expect(parseDiffString(diff)).toEqual([
      { type: "remove", text: "removed line", oldLine: 1 },
    ]);
  });

  test("parses context lines", () => {
    const diff = " 1 context line";
    expect(parseDiffString(diff)).toEqual([
      { type: "context", text: "context line", newLine: 1 },
    ]);
  });

  test("parses mixed diff with context, adds, and removes", () => {
    const diff = [
      " 1 before",
      "-2 old line",
      "+2 new line",
      " 3 after",
    ].join("\n");
    expect(parseDiffString(diff)).toEqual([
      { type: "context", text: "before", newLine: 1 },
      { type: "remove", text: "old line", oldLine: 2 },
      { type: "add", text: "new line", newLine: 2 },
      { type: "context", text: "after", newLine: 3 },
    ]);
  });

  test("parses ellipsis lines as context separators", () => {
    const diff = [
      " 1 before",
      "    ...",
      " 50 after",
    ].join("\n");
    const result = parseDiffString(diff);
    expect(result).toEqual([
      { type: "context", text: "before", newLine: 1 },
      { type: "context", text: "⋯", newLine: undefined },
      { type: "context", text: "after", newLine: 50 },
    ]);
  });

  test("handles padded line numbers", () => {
    const diff = [
      "+  1 first",
      "+ 10 tenth",
      "+100 hundredth",
    ].join("\n");
    expect(parseDiffString(diff)).toEqual([
      { type: "add", text: "first", newLine: 1 },
      { type: "add", text: "tenth", newLine: 10 },
      { type: "add", text: "hundredth", newLine: 100 },
    ]);
  });

  test("returns empty array for empty string", () => {
    expect(parseDiffString("")).toEqual([]);
  });

  test("handles empty line content after line number", () => {
    const diff = "+ 5 ";
    expect(parseDiffString(diff)).toEqual([
      { type: "add", text: "", newLine: 5 },
    ]);
  });
});

describe("getEditDiffLines", () => {
  test("prefers details.diff over oldText/newText", () => {
    const block = makeEditBlock({
      args: { path: "f.ts", oldText: "a", newText: "b" },
      result: {
        content: [{ type: "text" as const, text: "ok" }],
        details: {
          diff: " 1 context\n-2 old\n+2 new\n 3 after",
        },
      },
    });
    const lines = getEditDiffLines(block);
    expect(lines).toEqual([
      { type: "context", text: "context", newLine: 1 },
      { type: "remove", text: "old", oldLine: 2 },
      { type: "add", text: "new", newLine: 2 },
      { type: "context", text: "after", newLine: 3 },
    ]);
  });

  test("falls back to naive diff when no details", () => {
    const block = makeEditBlock({
      args: { path: "f.ts", oldText: "a", newText: "b" },
    });
    const lines = getEditDiffLines(block);
    expect(lines).toEqual([
      { type: "remove", text: "a", oldLine: 1 },
      { type: "add", text: "b", newLine: 1 },
    ]);
  });
});

describe("shouldAutoExpand", () => {
  /** Build an edit block whose diff has exactly `n` lines. */
  function blockWithDiffLines(n: number): ToolBlockData {
    const oldLines = Array.from({ length: n }, (_, i) => `old${i}`).join("\n");
    return makeEditBlock({
      args: { path: "f.ts", oldText: oldLines, newText: "" },
    });
  }

  test("returns true for small diffs (≤ threshold)", () => {
    expect(shouldAutoExpand(blockWithDiffLines(5))).toBe(true);
  });

  test("returns false for large diffs (> threshold)", () => {
    expect(shouldAutoExpand(blockWithDiffLines(AUTO_EXPAND_THRESHOLD + 1))).toBe(false);
  });

  test("returns true at exact threshold", () => {
    expect(shouldAutoExpand(blockWithDiffLines(AUTO_EXPAND_THRESHOLD))).toBe(true);
  });

  test("returns false when diff is empty", () => {
    const block = makeEditBlock({ args: { path: "f.ts", oldText: "", newText: "" } });
    expect(shouldAutoExpand(block)).toBe(false);
  });
});

describe("shouldShowEditDiff", () => {
  /** Build an edit block whose diff has exactly `n` lines. */
  function blockWithDiffLines(n: number): ToolBlockData {
    const oldLines = Array.from({ length: n }, (_, i) => `old${i}`).join("\n");
    return makeEditBlock({
      args: { path: "f.ts", oldText: oldLines, newText: "" },
    });
  }

  test("shows diff when expanded is true", () => {
    const block = blockWithDiffLines(AUTO_EXPAND_THRESHOLD + 1);
    expect(shouldShowEditDiff({ block, expanded: true })).toBe(true);
  });

  test("hides diff when expanded is false", () => {
    const block = blockWithDiffLines(AUTO_EXPAND_THRESHOLD + 1);
    expect(shouldShowEditDiff({ block, expanded: false })).toBe(false);
  });

  test("returns false when spinner is showing", () => {
    const block = blockWithDiffLines(3);
    expect(shouldShowEditDiff({ block, expanded: true, showSpinner: true })).toBe(false);
  });

  test("returns false on error blocks", () => {
    const block = { ...blockWithDiffLines(3), isError: true };
    expect(shouldShowEditDiff({ block, expanded: true })).toBe(false);
  });

  test("returns false when diff is empty", () => {
    const block = makeEditBlock({ args: { path: "f.ts", oldText: "", newText: "" } });
    expect(shouldShowEditDiff({ block, expanded: true })).toBe(false);
  });
});

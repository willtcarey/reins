/**
 * Tests for diff-utils — pure helper functions used by diff-panel.
 */
import { describe, test, expect } from "bun:test";
import {
  isMarkdown,
  fileCardId,
  escapeHtml,
  gutterWidth,
  getHunkEndLine,
  EXPAND_STEP,
} from "../models/changes/diff-utils.js";
import type { DiffFile, DiffHunk } from "../models/changes/types.js";

// ---- Helpers to build test data --------------------------------------------

function makeLine(
  type: "context" | "add" | "remove",
  text: string,
  opts: { oldLine?: number; newLine?: number } = {},
) {
  return { type, text, ...opts };
}

function makeHunk(lines: ReturnType<typeof makeLine>[], header = "@@ ..."): DiffHunk {
  return { header, lines };
}

function makeFile(path: string, hunks: DiffHunk[]): DiffFile {
  return { path, additions: 0, removals: 0, hunks };
}

// ---- EXPAND_STEP -----------------------------------------------------------

describe("EXPAND_STEP", () => {
  test("equals 15", () => {
    expect(EXPAND_STEP).toBe(15);
  });
});

// ---- isMarkdown ------------------------------------------------------------

describe("isMarkdown", () => {
  test("returns true for .md", () => {
    expect(isMarkdown("README.md")).toBe(true);
  });

  test("returns true for .mdx", () => {
    expect(isMarkdown("docs/guide.mdx")).toBe(true);
  });

  test("returns true for .markdown", () => {
    expect(isMarkdown("notes.markdown")).toBe(true);
  });

  test("is case-insensitive", () => {
    expect(isMarkdown("FILE.MD")).toBe(true);
    expect(isMarkdown("file.Md")).toBe(true);
    expect(isMarkdown("file.MARKDOWN")).toBe(true);
  });

  test("returns false for non-markdown extensions", () => {
    expect(isMarkdown("file.txt")).toBe(false);
    expect(isMarkdown("file.ts")).toBe(false);
    expect(isMarkdown("file.js")).toBe(false);
    expect(isMarkdown("file.json")).toBe(false);
  });

  test("returns false when 'md' appears but not as extension", () => {
    expect(isMarkdown("markdown-parser.ts")).toBe(false);
    expect(isMarkdown("cmd/main.go")).toBe(false);
    expect(isMarkdown("readme.md.bak")).toBe(false);
  });
});

// ---- fileCardId ------------------------------------------------------------

describe("fileCardId", () => {
  test("prefixes with 'diff-'", () => {
    expect(fileCardId("app.ts")).toStartWith("diff-");
  });

  test("preserves alphanumeric, hyphens, and underscores", () => {
    expect(fileCardId("my-file_name")).toBe("diff-my-file_name");
  });

  test("replaces dots with underscores", () => {
    expect(fileCardId("app.ts")).toBe("diff-app_ts");
  });

  test("replaces slashes with underscores", () => {
    expect(fileCardId("src/changes/diff-panel.ts")).toBe(
      "diff-src_changes_diff-panel_ts",
    );
  });

  test("replaces spaces and other special chars", () => {
    expect(fileCardId("my file (1).ts")).toBe("diff-my_file__1__ts");
  });
});

// ---- escapeHtml ------------------------------------------------------------

describe("escapeHtml", () => {
  test("escapes ampersand", () => {
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });

  test("escapes less-than", () => {
    expect(escapeHtml("<div>")).toBe("&lt;div&gt;");
  });

  test("escapes greater-than", () => {
    expect(escapeHtml("a > b")).toBe("a &gt; b");
  });

  test("leaves normal text unchanged", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });

  test("handles empty string", () => {
    expect(escapeHtml("")).toBe("");
  });

  test("handles multiple special chars together", () => {
    expect(escapeHtml("<a href=\"&\">x</a>")).toBe(
      "&lt;a href=\"&amp;\"&gt;x&lt;/a&gt;",
    );
  });
});

// ---- gutterWidth -----------------------------------------------------------

describe("gutterWidth", () => {
  test("returns minimum of 3 for small line numbers", () => {
    const file = makeFile("a.ts", [
      makeHunk([makeLine("context", "x", { newLine: 1 })]),
    ]);
    expect(gutterWidth(file)).toBe(3);
  });

  test("returns 3 for line numbers up to 99", () => {
    const file = makeFile("a.ts", [
      makeHunk([makeLine("context", "x", { newLine: 99 })]),
    ]);
    // digits = 2, +1 = 3 → max(3, 3) = 3
    expect(gutterWidth(file)).toBe(3);
  });

  test("scales with max line number (100 → 4)", () => {
    const file = makeFile("a.ts", [
      makeHunk([makeLine("context", "x", { newLine: 100 })]),
    ]);
    expect(gutterWidth(file)).toBe(4);
  });

  test("scales with max line number (1000 → 5)", () => {
    const file = makeFile("a.ts", [
      makeHunk([makeLine("context", "x", { newLine: 1000 })]),
    ]);
    expect(gutterWidth(file)).toBe(5);
  });

  test("considers oldLine as well", () => {
    const file = makeFile("a.ts", [
      makeHunk([makeLine("remove", "x", { oldLine: 5000 })]),
    ]);
    expect(gutterWidth(file)).toBe(5);
  });

  test("picks the max across multiple hunks", () => {
    const file = makeFile("a.ts", [
      makeHunk([makeLine("context", "x", { newLine: 5 })]),
      makeHunk([makeLine("context", "y", { newLine: 12345 })]),
    ]);
    expect(gutterWidth(file)).toBe(6);
  });

  test("returns 3 for empty hunks", () => {
    const file = makeFile("a.ts", [makeHunk([])]);
    expect(gutterWidth(file)).toBe(3);
  });

  test("returns 3 for file with no hunks", () => {
    const file = makeFile("a.ts", []);
    expect(gutterWidth(file)).toBe(3);
  });

  test("returns 3 for lines with no line numbers", () => {
    const file = makeFile("a.ts", [
      makeHunk([makeLine("context", "x")]),
    ]);
    expect(gutterWidth(file)).toBe(3);
  });
});

// ---- getHunkEndLine --------------------------------------------------------

describe("getHunkEndLine", () => {
  test("returns last newLine from hunk lines", () => {
    const hunk = makeHunk([
      makeLine("context", "a", { newLine: 10 }),
      makeLine("add", "b", { newLine: 11 }),
      makeLine("context", "c", { newLine: 12 }),
    ]);
    expect(getHunkEndLine(hunk)).toBe(12);
  });

  test("falls back to oldLine if no newLine on last line", () => {
    const hunk = makeHunk([
      makeLine("context", "a", { newLine: 10 }),
      makeLine("remove", "b", { oldLine: 20 }),
    ]);
    expect(getHunkEndLine(hunk)).toBe(20);
  });

  test("returns 0 for empty hunk", () => {
    const hunk = makeHunk([]);
    expect(getHunkEndLine(hunk)).toBe(0);
  });

  test("scans from end — finds last line, not first", () => {
    const hunk = makeHunk([
      makeLine("context", "a", { newLine: 1 }),
      makeLine("context", "b", { newLine: 2 }),
      makeLine("context", "c", { newLine: 99 }),
    ]);
    expect(getHunkEndLine(hunk)).toBe(99);
  });

  test("skips lines without any line numbers at the end", () => {
    const hunk = makeHunk([
      makeLine("context", "a", { newLine: 50 }),
      makeLine("context", "b"), // no line numbers
    ]);
    // Should skip the last line (no numbers) and return 50
    expect(getHunkEndLine(hunk)).toBe(50);
  });

  test("prefers newLine over oldLine on the same line", () => {
    const hunk = makeHunk([
      makeLine("context", "a", { oldLine: 5, newLine: 10 }),
    ]);
    expect(getHunkEndLine(hunk)).toBe(10);
  });
});

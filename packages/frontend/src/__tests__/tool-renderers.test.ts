import { describe, test, expect } from "bun:test";
import { getToolRenderer } from "../tool-renderers/index.js";
import { getToolSummary } from "../tool-renderers/base.js";
import { genericRenderer } from "../tool-renderers/generic.js";
import { readRenderer, getReadSummary, getReadPreview, getReadContent, getReadLineCount, getReadRange, getReadTrailer } from "../tool-renderers/read.js";
import { bashRenderer, getBashCommand, getBashPreview, getBashOutput, getBashExitInfo } from "../tool-renderers/bash.js";
import { editRenderer, getEditSummary, getEditStats, computeEditDiff, parseDiffString, getEditDiffLines } from "../tool-renderers/edit.js";
import { writeRenderer, getWriteSummary, getWriteInfo } from "../tool-renderers/write.js";
import { createTaskRenderer, getTaskSummary, getTaskDetail } from "../tool-renderers/create-task.js";
import { delegateRenderer, getDelegateSummary, getDelegateDetail } from "../tool-renderers/delegate.js";
import type { ToolBlockData } from "../chat-state.js";

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe("getToolRenderer", () => {
  test("returns generic renderer for unknown tool names", () => {
    const renderer = getToolRenderer("SomeUnknownTool");
    expect(renderer).toBe(genericRenderer);
  });

  test("returns generic renderer for empty string", () => {
    const renderer = getToolRenderer("");
    expect(renderer).toBe(genericRenderer);
  });

  test("returns read renderer for 'read'", () => {
    expect(getToolRenderer("read")).toBe(readRenderer);
  });

  test("returns bash renderer for 'bash'", () => {
    expect(getToolRenderer("bash")).toBe(bashRenderer);
  });

  test("returns edit renderer for 'edit'", () => {
    expect(getToolRenderer("edit")).toBe(editRenderer);
  });

  test("returns write renderer for 'write'", () => {
    expect(getToolRenderer("write")).toBe(writeRenderer);
  });

  test("returns createTask renderer for 'create_task'", () => {
    expect(getToolRenderer("create_task")).toBe(createTaskRenderer);
  });

  test("returns delegate renderer for 'delegate'", () => {
    expect(getToolRenderer("delegate")).toBe(delegateRenderer);
  });
});

// ---------------------------------------------------------------------------
// getToolSummary — pure logic extracted from chat-panel.ts toolSummary()
// ---------------------------------------------------------------------------

describe("getToolSummary", () => {
  test("returns empty string when args is undefined", () => {
    expect(getToolSummary("bash", undefined)).toBe("");
  });

  test("returns empty string when args is empty object", () => {
    expect(getToolSummary("bash", {})).toBe("");
  });

  test("bash: returns command", () => {
    expect(getToolSummary("bash", { command: "ls -la" })).toBe("ls -la");
  });

  test("Bash: case-insensitive match", () => {
    expect(getToolSummary("Bash", { command: "echo hello" })).toBe("echo hello");
  });

  test("read: returns path", () => {
    expect(getToolSummary("read", { path: "/etc/hosts" })).toBe("/etc/hosts");
  });

  test("Read: case-insensitive match", () => {
    expect(getToolSummary("Read", { path: "src/index.ts" })).toBe("src/index.ts");
  });

  test("edit: returns path", () => {
    expect(getToolSummary("Edit", { path: "foo.ts", oldText: "a", newText: "b" })).toBe("foo.ts");
  });

  test("write: returns path", () => {
    expect(getToolSummary("Write", { path: "bar.ts", content: "stuff" })).toBe("bar.ts");
  });

  test("generic: returns first string arg, truncated to 120 chars", () => {
    const longVal = "x".repeat(200);
    const result = getToolSummary("some_tool", { key: longVal });
    expect(result).toBe("x".repeat(117) + "…");
  });

  test("generic: returns first non-empty string arg", () => {
    expect(getToolSummary("some_tool", { a: 42, b: "", c: "hello" })).toBe("hello");
  });

  test("generic: returns empty string when no string args", () => {
    expect(getToolSummary("some_tool", { a: 42, b: true })).toBe("");
  });

  test("generic: short string is not truncated", () => {
    expect(getToolSummary("some_tool", { title: "My Task" })).toBe("My Task");
  });
});

// ---------------------------------------------------------------------------
// Read renderer — pure logic helpers
// ---------------------------------------------------------------------------

function makeToolBlock(overrides: Partial<ToolBlockData> = {}): ToolBlockData {
  return {
    type: "tool",
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

describe("getReadContent strips trailer", () => {
  test("content excludes the trailing metadata line", () => {
    const block = makeToolBlock({
      result: makeReadResult("line one\nline two\n\n[163 more lines in file. Use offset=51 to continue.]"),
    });
    expect(getReadContent(block)).toBe("line one\nline two");
  });
});

describe("getReadLineCount strips trailer", () => {
  test("line count excludes the trailing metadata line", () => {
    const block = makeToolBlock({
      result: makeReadResult("a\nb\nc\n\n[50 more lines in file. Use offset=10 to continue.]"),
    });
    expect(getReadLineCount(block)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Bash renderer — pure logic helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Edit renderer — pure logic helpers
// ---------------------------------------------------------------------------

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

describe("getEditStats with details.diff", () => {
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

// ---------------------------------------------------------------------------
// Write renderer — pure logic helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// create_task renderer — pure logic helpers
// ---------------------------------------------------------------------------

function makeCreateTaskBlock(overrides: Partial<ToolBlockData> = {}): ToolBlockData {
  return {
    type: "tool",
    id: "task-test-id",
    name: "create_task",
    args: { title: "Add dark mode", description: "Implement dark mode toggle in settings panel", branch_name: "task/dark-mode" },
    status: "done",
    ...overrides,
  };
}

describe("getTaskSummary", () => {
  test("returns task title from args", () => {
    expect(getTaskSummary(makeCreateTaskBlock())).toBe("Add dark mode");
  });

  test("returns empty string when args has no title", () => {
    expect(getTaskSummary(makeCreateTaskBlock({ args: {} }))).toBe("");
  });

  test("returns empty string when args is undefined", () => {
    expect(getTaskSummary(makeCreateTaskBlock({ args: undefined as any }))).toBe("");
  });
});

describe("getTaskDetail", () => {
  test("returns description and branch", () => {
    expect(getTaskDetail(makeCreateTaskBlock())).toEqual({
      description: "Implement dark mode toggle in settings panel",
      branch: "task/dark-mode",
    });
  });

  test("returns empty strings when args are missing", () => {
    expect(getTaskDetail(makeCreateTaskBlock({ args: {} }))).toEqual({
      description: "",
      branch: "",
    });
  });

  test("returns empty strings when args is undefined", () => {
    expect(getTaskDetail(makeCreateTaskBlock({ args: undefined as any }))).toEqual({
      description: "",
      branch: "",
    });
  });

  test("handles missing branch gracefully", () => {
    const block = makeCreateTaskBlock({ args: { title: "Test", description: "Desc" } });
    expect(getTaskDetail(block)).toEqual({
      description: "Desc",
      branch: "",
    });
  });
});

// ---------------------------------------------------------------------------
// delegate renderer — pure logic helpers
// ---------------------------------------------------------------------------

function makeDelegateBlock(overrides: Partial<ToolBlockData> = {}): ToolBlockData {
  return {
    type: "tool",
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
    expect(getDelegateSummary(makeDelegateBlock({ args: undefined as any }))).toBe("");
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
    expect(getDelegateDetail(makeDelegateBlock({ args: undefined as any }))).toEqual({ prompt: "" });
  });
});

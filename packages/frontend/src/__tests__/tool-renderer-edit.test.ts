import { describe, test, expect } from "bun:test";
import {
  getEditSummary,
  getEditStats,
  parseDiffString,
  getEditDiffLines,
  shouldShowEditDiff,
  shouldAutoExpand,
  AUTO_EXPAND_THRESHOLD,
} from "../models/tools/edit.js";
import type { ToolBlockData } from "../models/chat-state.js";

function makeEditBlock(overrides: Partial<ToolBlockData> = {}): ToolBlockData {
  return {
    id: "edit-test-id",
    name: "Edit",
    args: { path: "src/app.ts", oldText: "foo", newText: "bar" },
    status: "done",
    ...overrides,
  };
}

function blockWithDiffLines(n: number): ToolBlockData {
  const oldLines = Array.from({ length: n }, (_, i) => `old${i}`).join("\n");
  return makeEditBlock({ args: { path: "f.ts", oldText: oldLines, newText: "" } });
}

describe("Edit tool model helpers", () => {
  test("extracts the edited path while tolerating missing args", () => {
    expect(getEditSummary(makeEditBlock())).toBe("src/app.ts");
    expect(getEditSummary(makeEditBlock({ args: {} }))).toBe("");
    expect(getEditSummary(makeEditBlock({ args: undefined }))).toBe("");
  });

  test("counts additions and removals from server diffs or edit args", () => {
    const fromDiff = makeEditBlock({
      result: {
        content: [{ type: "text" as const, text: "ok" }],
        details: { diff: " 1 context\n-2 removed\n-3 removed again\n+2 added" },
      },
    });
    const fromArgs = makeEditBlock({
      args: { path: "f.ts", oldText: "a\nb", newText: "c" },
    });

    expect(getEditStats(fromDiff)).toEqual({ additions: 1, removals: 2 });
    expect(getEditStats(fromArgs)).toEqual({ additions: 1, removals: 2 });
    expect(getEditStats(makeEditBlock({ args: undefined }))).toEqual({ additions: 0, removals: 0 });
  });

  test("parses the SDK diff format used for rendered edit lines", () => {
    const diff = [
      "  1 before",
      "- 2 old line",
      "+  2 new line",
      "    ...",
      " 10 after",
    ].join("\n");

    expect(parseDiffString(diff)).toEqual([
      { type: "context", text: "before", newLine: 1 },
      { type: "remove", text: "old line", oldLine: 2 },
      { type: "add", text: "new line", newLine: 2 },
      { type: "context", text: "⋯", newLine: undefined },
      { type: "context", text: "after", newLine: 10 },
    ]);
  });

  test("prefers server diff details and falls back to oldText/newText", () => {
    const withServerDiff = makeEditBlock({
      args: { path: "f.ts", oldText: "fallback old", newText: "fallback new" },
      result: {
        content: [{ type: "text" as const, text: "ok" }],
        details: { diff: " 1 context\n-2 old\n+2 new" },
      },
    });

    expect(getEditDiffLines(withServerDiff)).toEqual([
      { type: "context", text: "context", newLine: 1 },
      { type: "remove", text: "old", oldLine: 2 },
      { type: "add", text: "new", newLine: 2 },
    ]);
    expect(getEditDiffLines(makeEditBlock({ args: { path: "f.ts", oldText: "a", newText: "b" } }))).toEqual([
      { type: "remove", text: "a", oldLine: 1 },
      { type: "add", text: "b", newLine: 1 },
    ]);
  });

  test("auto-expands only non-empty diffs within the threshold", () => {
    expect(shouldAutoExpand(blockWithDiffLines(2))).toBe(true);
    expect(shouldAutoExpand(blockWithDiffLines(AUTO_EXPAND_THRESHOLD + 1))).toBe(false);
    expect(shouldAutoExpand(makeEditBlock({ args: { path: "f.ts", oldText: "", newText: "" } }))).toBe(false);
  });

  test("shows expanded diffs unless the block is suppressed", () => {
    const block = blockWithDiffLines(3);

    expect(shouldShowEditDiff({ block, expanded: true })).toBe(true);
    expect(shouldShowEditDiff({ block, expanded: false })).toBe(false);
    expect(shouldShowEditDiff({ block, expanded: true, showSpinner: true })).toBe(false);
    expect(shouldShowEditDiff({ block: { ...block, isError: true }, expanded: true })).toBe(false);
    expect(shouldShowEditDiff({ block: makeEditBlock({ args: { path: "f.ts", oldText: "", newText: "" } }), expanded: true })).toBe(false);
  });
});

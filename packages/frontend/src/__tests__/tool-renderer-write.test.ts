import { describe, test, expect } from "bun:test";
import { WriteToolBlock } from "../components/tools/write.js";
import { getWriteSummary, getWriteInfo } from "../models/tools/write.js";
import type { ToolBlockData } from "../models/chat-state.js";

function makeWriteBlock(overrides: Partial<ToolBlockData> = {}): ToolBlockData {
  return {
    id: "write-test-id",
    name: "Write",
    args: { path: "src/new-file.ts", content: "line1\nline2\nline3" },
    status: "done",
    ...overrides,
  };
}

describe("Write tool model helpers", () => {
  test("extracts the file path while tolerating missing args", () => {
    expect(getWriteSummary(makeWriteBlock())).toBe("src/new-file.ts");
    expect(getWriteSummary(makeWriteBlock({ args: {} }))).toBe("");
    expect(getWriteSummary(makeWriteBlock({ args: undefined }))).toBe("");
  });

  test("counts written lines and treats missing content as empty", () => {
    expect(getWriteInfo(makeWriteBlock())).toEqual({ lines: 3 });
    expect(getWriteInfo(makeWriteBlock({ args: { path: "f.ts", content: "hello" } }))).toEqual({ lines: 1 });
    expect(getWriteInfo(makeWriteBlock({ args: { path: "f.ts", content: "" } }))).toEqual({ lines: 0 });
    expect(getWriteInfo(makeWriteBlock({ args: undefined }))).toEqual({ lines: 0 });
  });

  test("leaves unhighlighted source text for Lit to escape once", () => {
    const renderLine = Reflect.get(WriteToolBlock.prototype, "_renderHighlightedLine");
    const host = { _hl: { getLineHtml: () => undefined } };

    const rendered = Reflect.apply(renderLine, host, [0, "const node = <div>;"]) as string;
    expect(rendered).toBe("const node = <div>;");
  });
});

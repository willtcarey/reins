import { describe, test, expect } from "bun:test";
import { getToolRenderer } from "../tool-renderers/index.js";
import { getToolSummary } from "../tool-renderers/generic.js";
import { genericRenderer } from "../tool-renderers/generic.js";
import { readRenderer } from "../tool-renderers/read.js";
import { bashRenderer } from "../tool-renderers/bash.js";
import { editRenderer } from "../tool-renderers/edit.js";
import { writeRenderer } from "../tool-renderers/write.js";
import { createTaskRenderer } from "../tool-renderers/create-task.js";
import { delegateRenderer } from "../tool-renderers/delegate.js";

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
// getToolSummary — generic fallback summary (tool-specific renderers have
// their own logic so only unknown/generic tools go through this)
// ---------------------------------------------------------------------------

describe("getToolSummary", () => {
  test("returns empty string when args is undefined", () => {
    expect(getToolSummary("some_tool", undefined)).toBe("");
  });

  test("returns empty string when args is empty object", () => {
    expect(getToolSummary("some_tool", {})).toBe("");
  });

  test("returns first string arg, truncated to 120 chars", () => {
    const longVal = "x".repeat(200);
    const result = getToolSummary("some_tool", { key: longVal });
    expect(result).toBe("x".repeat(117) + "…");
  });

  test("returns first non-empty string arg", () => {
    expect(getToolSummary("some_tool", { a: 42, b: "", c: "hello" })).toBe("hello");
  });

  test("returns empty string when no string args", () => {
    expect(getToolSummary("some_tool", { a: 42, b: true })).toBe("");
  });

  test("short string is not truncated", () => {
    expect(getToolSummary("some_tool", { title: "My Task" })).toBe("My Task");
  });
});

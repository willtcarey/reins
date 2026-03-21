import { describe, test, expect } from "bun:test";
import { getToolRenderer } from "../tool-renderers/index.js";
import { getToolSummary } from "../tool-renderers/base.js";
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

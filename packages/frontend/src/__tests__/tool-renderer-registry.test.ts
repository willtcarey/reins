import { describe, test, expect } from "bun:test";
import { getToolRenderer } from "../components/tools/index.js";
import { getToolSummary } from "../models/tools/generic.js";
import { genericRenderer } from "../components/tools/generic.js";
import { readRenderer } from "../components/tools/read.js";
import { bashRenderer } from "../components/tools/bash.js";
import { editRenderer } from "../components/tools/edit.js";
import { writeRenderer } from "../components/tools/write.js";
import { createTaskRenderer } from "../components/tools/create-task.js";
import { delegateRenderer } from "../components/tools/delegate.js";
import { executeRenderer } from "../components/tools/execute.js";
import { searchRenderer } from "../components/tools/search.js";

describe("tool renderer registry", () => {
  test("maps known tool names and falls back to generic rendering", () => {
    expect(getToolRenderer("read")).toBe(readRenderer);
    expect(getToolRenderer("bash")).toBe(bashRenderer);
    expect(getToolRenderer("edit")).toBe(editRenderer);
    expect(getToolRenderer("write")).toBe(writeRenderer);
    expect(getToolRenderer("create_task")).toBe(createTaskRenderer);
    expect(getToolRenderer("delegate")).toBe(delegateRenderer);
    expect(getToolRenderer("execute")).toBe(executeRenderer);
    expect(getToolRenderer("search")).toBe(searchRenderer);
    expect(getToolRenderer("SomeUnknownTool")).toBe(genericRenderer);
    expect(getToolRenderer("")).toBe(genericRenderer);
  });

  test("generic summaries use the first non-empty string arg and truncate long values", () => {
    expect(getToolSummary("some_tool", undefined)).toBe("");
    expect(getToolSummary("some_tool", { a: 42, b: true })).toBe("");
    expect(getToolSummary("some_tool", { a: 42, b: "", c: "hello" })).toBe("hello");
    expect(getToolSummary("some_tool", { key: "x".repeat(200) })).toBe("x".repeat(117) + "…");
  });
});

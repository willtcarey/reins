import { describe, test, expect } from "bun:test";
import * as ts from "typescript";
import { searchFunctions, API_FUNCTIONS, referencedTypes } from "../../scripting/api-registry.js";
import { createSearchTool } from "../../tools/search.js";
import { createStrictExtensionContext } from "../helpers/test-pi.js";

const strictCtx = createStrictExtensionContext();

// ---------------------------------------------------------------------------
// Registry search
// ---------------------------------------------------------------------------

describe("searchFunctions", () => {
  test("returns all entries for empty query", () => {
    const results = searchFunctions("");
    expect(results.length).toBe(API_FUNCTIONS.length);
  });

  test("filters by namespace keyword", () => {
    const results = searchFunctions("tasks");
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((e) => e.name.startsWith("tasks.") || e.tags.includes("task"))).toBe(true);
  });

  test("filters by function name", () => {
    const results = searchFunctions("tasks.list");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].name).toBe("tasks.list");
  });

  test("normalizes api-prefixed function queries", () => {
    const results = searchFunctions("api.tasks");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].name).toBe("tasks.list");
  });

  test("matches description keywords", () => {
    const results = searchFunctions("messages");
    expect(results.some((e) => e.name === "sessions.messages")).toBe(true);
  });

  test("matches tags", () => {
    const results = searchFunctions("write");
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((e) => e.tags.includes("write"))).toBe(true);
  });

  test("multi-word query requires all terms to match when strict matches exist", () => {
    const results = searchFunctions("create task");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((e) => e.name === "tasks.create")).toBe(true);
    expect(results.some((e) => e.name === "projects.list")).toBe(false);
  });

  test("falls back to merged per-term matches for long natural-language queries", () => {
    const results = searchFunctions("sessions messages tasks list");
    expect(results.some((e) => e.name === "sessions.messages")).toBe(true);
    expect(results.some((e) => e.name === "tasks.list")).toBe(true);
    expect(results.some((e) => e.name === "projects.list")).toBe(false);
  });

  test("returns empty for unmatched query", () => {
    const results = searchFunctions("xyznonexistent");
    expect(results).toEqual([]);
  });

  test("is case insensitive", () => {
    const results = searchFunctions("TASKS");
    expect(results.length).toBeGreaterThan(0);
  });

  test("name matches rank higher than description matches", () => {
    const results = searchFunctions("list");
    const nameMatchIdx = results.findIndex((e) => e.name.includes("list"));
    expect(nameMatchIdx).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Referenced types
// ---------------------------------------------------------------------------

describe("referencedTypes", () => {
  test("finds types referenced by function return schemas", () => {
    const fns = searchFunctions("tasks.list");
    const types = referencedTypes(fns);
    expect(types.some((t) => t.name === "Task")).toBe(true);
  });

  test("finds types in union returns", () => {
    const fns = searchFunctions("tasks.get");
    const types = referencedTypes(fns);
    expect(types.some((t) => t.name === "Task")).toBe(true);
  });

  test("deduplicates types across multiple functions", () => {
    const fns = searchFunctions("sessions");
    const types = referencedTypes(fns);
    const names = types.map((t) => t.name);
    expect(names.length).toBe(new Set(names).size);
  });
});

// ---------------------------------------------------------------------------
// Search tool
// ---------------------------------------------------------------------------

describe("createSearchTool", () => {
  test("returns a valid ToolDefinition", () => {
    const tool = createSearchTool();
    expect(tool.name).toBe("search");
    expect(typeof tool.description).toBe("string");
    expect(tool.parameters).toBeDefined();
    expect(typeof tool.execute).toBe("function");
  });

  test("has a label", () => {
    const tool = createSearchTool();
    expect(tool.label).toBe("Search API");
  });

  test("execute returns TypeScript documentation interfaces for a query", async () => {
    const tool = createSearchTool();
    const result = await tool.execute("call-1", { query: "tasks.list" }, undefined, undefined, strictCtx);

    expect(result.content).toBeArray();
    expect(result.content.length).toBe(1);
    expect(result.content[0].type).toBe("text");

    const text = result.content[0].type === "text" ? result.content[0].text : "";
    expect(text).toContain("## API documentation");
    expect(text).toContain("Documentation only");
    expect(text).toContain("existing `api` object");
    expect(text).toContain("positionally");
    expect(text).toContain("interface Api {");
    expect(text).toContain("tasks: TasksApi;");
    expect(text).toContain("interface TasksApi {");
    expect(text).toContain("list(status?: \"open\" | \"closed\"): Task[];");
    expect(text).not.toContain("tasks.list(");
    expectGeneratedTypeScriptToBeValid(text);
  });

  test("execute includes TypeScript interfaces for referenced types", async () => {
    const tool = createSearchTool();
    const result = await tool.execute("call-types", { query: "tasks.get" }, undefined, undefined, strictCtx);

    const text = result.content[0].type === "text" ? result.content[0].text : "";
    expect(text).toContain("interface Task {");
    expect(text).toContain("id: number;");
    expect(text).toContain("title: string;");
  });

  test("execute returns all entries for empty query", async () => {
    const tool = createSearchTool();
    const result = await tool.execute("call-2", { query: "" }, undefined, undefined, strictCtx);

    const text = result.content[0].type === "text" ? result.content[0].text : "";
    expect(text).toContain("tasks: TasksApi;");
    expect(text).toContain("sessions: SessionsApi;");
    expect(text).toContain("projects: ProjectsApi;");
    expectGeneratedTypeScriptToBeValid(text);
  });

  test("execute documents session filtering and tool trace APIs", async () => {
    const tool = createSearchTool();
    const result = await tool.execute("call-session-traces", { query: "sessions" }, undefined, undefined, strictCtx);

    const text = result.content[0].type === "text" ? result.content[0].text : "";
    expect(text).toContain("list(options?:");
    expect(text).toContain("messages(sessionId: string, options?:");
    expect(text).toContain("toolTrace(sessionId: string, options?:");
    expect(text).toContain("interface ToolCall {");
    expect(text).toContain('type: "toolCall";');
    expect(text).toContain("interface ToolResult {");
    expect(text).toContain('role: "toolResult";');
    expectGeneratedTypeScriptToBeValid(text);
  });

  test("execute returns no-results message for unmatched query", async () => {
    const tool = createSearchTool();
    const result = await tool.execute("call-3", { query: "xyznonexistent" }, undefined, undefined, strictCtx);

    const text = result.content[0].type === "text" ? result.content[0].text : "";
    expect(text).toContain("No matching");
  });
});

function expectGeneratedTypeScriptToBeValid(text: string): void {
  const match = text.match(/```typescript\n([\s\S]*?)\n```/);
  expect(match).not.toBeNull();
  const source = match?.[1] ?? "";
  const result = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  });

  expect(result.diagnostics ?? []).toEqual([]);
}

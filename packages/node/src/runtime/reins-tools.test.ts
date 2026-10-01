import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/pi-agent-core";
import type { ReinsToolCalls } from "@reins/node-protocol";
import { createReinsTools, ToolCallNotRun, ToolCallOutcomeUnknown, type ReinsTool } from "./reins-tools.js";

/** Snapshot of the backend tool definitions before they moved to the node: the model-visible
 * surface (names, labels, descriptions, parameter JSON schema, order) must not change. */
const MODEL_VISIBLE_SURFACE: unknown = [
  {
    "name": "create_task",
    "label": "Create Task",
    "description": "Create a new task for the current project with a dedicated git branch. Only use this when the user explicitly asks you to create a task — do not proactively create tasks.",
    "parameters": {
      "type": "object",
      "required": [
        "title",
        "description"
      ],
      "properties": {
        "title": {
          "description": "Concise task title (imperative mood, e.g. \"Add dark mode support\")",
          "type": "string"
        },
        "description": {
          "description": "Brief description with actionable detail (1-3 sentences)",
          "type": "string"
        },
        "branch_name": {
          "description": "Git branch name in task/<slug> format. If omitted, derived from the title.",
          "type": "string"
        },
        "prompt": {
          "description": "Optional initial prompt to kick off a session on the new task. The session starts in the background (fire-and-forget) — the tool returns immediately. Use this to start work on the task right away.",
          "type": "string"
        }
      }
    },
    "replay": "never"
  },
  {
    "name": "search",
    "label": "Search API",
    "description": "Discover Reins internal API functions available to the `execute` tool. Returns documentation-only TypeScript interfaces for the existing `api` object and referenced domain types, filtered by query. Use this before writing `execute` scripts for Reins-managed data or UI state. Use an empty query to inspect the full API surface. In `execute` scripts, call methods on the provided `api` object; these interfaces are documentation only.",
    "parameters": {
      "type": "object",
      "required": [
        "query"
      ],
      "properties": {
        "query": {
          "description": "What you're looking for — a category, function name, or description. Use an empty string to inspect the full API surface.",
          "type": "string"
        }
      }
    },
    "replay": "never"
  },
  {
    "name": "execute",
    "label": "Execute",
    "description": "Run async JavaScript against Reins internals. Write a function body using the existing `api` object. Use the `search` tool to discover functions not already documented in the system prompt.",
    "parameters": {
      "type": "object",
      "required": [
        "code"
      ],
      "properties": {
        "code": {
          "description": "Async JavaScript function body. Has access to the existing `api` object for Reins-managed data or UI state. Use `return` to produce a result. Use the `search` tool for functions not already documented in the system prompt.",
          "type": "string"
        }
      }
    },
    "replay": "never"
  }
];

const unexpected = async (): Promise<never> => { throw new Error("unexpected call"); };
const calls = (overrides: Partial<ReinsToolCalls> = {}): ReinsToolCalls => ({
  executeScript: unexpected, searchScript: unexpected, createTask: unexpected, ...overrides,
});
const tool = (name: string, overrides: Partial<ReinsToolCalls>) => createReinsTools(calls(overrides)).find(item => item.name === name)!;
function run(item: ReinsTool, params: Record<string, unknown>, signal?: AbortSignal) {
  const context = signal ? withAbortSignal(signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT;
  const invocation = { invocationId: "call", operationId: "call", turnId: "turn", async getMemo() { return undefined; }, async setMemo() {} };
  return item.execute("call", params, () => undefined, undefined, invocation, context);
}
const textOf = (result: { content: Array<{ type: string; text?: string }> }) => result.content.map(item => item.text).join("");

test("the model-visible tool surface is unchanged from the server-side definitions", () => {
  const surface: unknown = createReinsTools(calls()).map(item => ({
    name: item.name, label: item.label, description: item.description,
    parameters: JSON.parse(JSON.stringify(item.parameters)), replay: item.replay,
  }));
  expect(surface).toEqual(MODEL_VISIBLE_SURFACE);
});

test("execute returns the script's text, and a script error reaches the model unchanged", async () => {
  const seen: Array<{ code: string; signal?: AbortSignal }> = [];
  const execute = tool("execute", { executeScript: async (code, signal) => { seen.push({ code, signal }); return code === "ok" ? { ok: true, text: "42" } : { ok: false, error: "boom" }; } });
  expect(await run(execute, { code: "ok" })).toEqual({ content: [{ type: "text", text: "42" }], details: { success: true } });
  expect(await run(execute, { code: "fail" })).toEqual({ content: [{ type: "text", text: "Error: boom" }], details: { success: false, error: "boom" } });
  const controller = new AbortController();
  await run(execute, { code: "ok" }, controller.signal);
  expect(seen[2]!.signal?.aborted).toBe(false);
  controller.abort();
  expect(seen[2]!.signal?.aborted).toBe(true);
});

test("an unknown outcome is stated for side-effecting tools and each call is attempted once", async () => {
  let attempts = 0;
  const unknown = async (): Promise<never> => { attempts++; throw new ToolCallOutcomeUnknown("Call timed out after 300000ms; outcome unknown"); };
  const execute = await run(tool("execute", { executeScript: unknown }), { code: "return 1" });
  expect(textOf(execute)).toBe("Error: Call timed out after 300000ms; outcome unknown. The script's outcome is unknown: it may have run, with side effects. Check before re-running it.");
  expect(execute.details).toEqual({ success: false, error: "Call timed out after 300000ms; outcome unknown" });
  const created = await run(tool("create_task", { createTask: unknown }), { title: "T", description: "D" });
  expect(textOf(created)).toContain("The outcome is unknown: the task may have been created.");
  expect(created.details).toBeNull();
  expect(attempts).toBe(2);

  const notRun = async (): Promise<never> => { throw new ToolCallNotRun("Reins server connection unavailable"); };
  expect(textOf(await run(tool("execute", { executeScript: notRun }), { code: "x" }))).toBe("Error: Reins server connection unavailable. The script did not run.");
  expect(textOf(await run(tool("create_task", { createTask: notRun }), { title: "T", description: "D" }))).toBe("Error: Reins server connection unavailable. The task was not created.");
  expect(await run(tool("search", { searchScript: notRun }), { query: "" })).toEqual({ content: [{ type: "text", text: "Error: Reins server connection unavailable" }], details: { matchCount: 0 } });
  // A definitive server rejection is reported as before.
  expect(textOf(await run(tool("create_task", { createTask: async () => { throw new Error("Project not found"); } }), { title: "T", description: "D" }))).toBe("Error: Project not found");
});

test("create_task forwards the model's parameters and reports whether a session is starting", async () => {
  const inputs: unknown[] = [];
  const task = { id: 7, title: "T", branch_name: "task/t" };
  const create = tool("create_task", { createTask: async input => { inputs.push(input); return { task, sessionStarting: input.prompt !== undefined }; } });
  expect(await run(create, { title: "T", description: "D" })).toEqual({ content: [{ type: "text", text: JSON.stringify(task, null, 2) }], details: task });
  const started = await run(create, { title: "T", description: "D", branch_name: "task/x", prompt: "Go" });
  expect(JSON.parse(textOf(started))).toEqual({ ...task, _note: "Session started in background — watch for progress via WebSocket events." });
  expect(inputs).toEqual([{ title: "T", description: "D" }, { title: "T", description: "D", branchName: "task/x", prompt: "Go" }]);
});

test("search returns the server's documentation text and match count", async () => {
  const search = tool("search", { searchScript: async query => ({ text: `docs for ${query}`, matchCount: 3 }) });
  expect(await run(search, { query: "tasks" })).toEqual({ content: [{ type: "text", text: "docs for tasks" }], details: { matchCount: 3 } });
});

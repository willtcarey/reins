/**
 * A backend extension for tests of the server SDK's host: a provider of fixed tools, with whatever else a
 * test registers through `setup`. It records what the host gives it (`searches`, `calls`) and whether it
 * was disposed.
 */

import type { Disposer, RegisterExtension, ServerSdk, Tool, ToolFilters, ToolResult } from "@reins/sdk/server";

export interface TestExtension {
  register: RegisterExtension;
  readonly searches: { query: string; filters: ToolFilters }[];
  readonly calls: { id: string; args: Record<string, unknown>; timeoutMs?: number }[];
  readonly disposed: boolean;
}

/** A tool with a one-argument schema. */
export function testTool(id: string, description = `Does ${id}`): Tool {
  return { id, name: id, description, inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } };
}

/** A provider titled `title` that searches `tools` with the SDK's `match` (and only those whose `group` filter
 * matches the ID's prefix before `__`, when the filter is given), and runs a tool by answering its local ID
 * and arguments (an unknown one throws). `setup` registers more and returns its disposer. */
export function testExtension(
  { title = "Test tools", tools = [], setup }: { title?: string; tools?: Tool[]; setup?: (reins: ServerSdk) => Disposer | void } = {},
): TestExtension {
  const searches: TestExtension["searches"] = [];
  const calls: TestExtension["calls"] = [];
  let disposed = false;
  const register: RegisterExtension = reins => {
    const removeProvider = reins.tools.register({
      title,
      async search(query, { filters }) {
        searches.push({ query, filters });
        const group = typeof filters.group === "string" ? filters.group : null;
        return reins.tools.match(query, tools.filter(tool => !group || tool.id.startsWith(`${group}__`)));
      },
      async call(id, args, { timeoutMs }) {
        if (!tools.some(tool => tool.id === id)) throw new Error(`No such tool: ${id}`);
        calls.push({ id, args, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
        const result: ToolResult = { content: [{ type: "text", text: `${title}: ${id} ${JSON.stringify(args)}` }] };
        return result;
      },
    });
    const more = setup?.(reins);
    return async () => {
      disposed = true;
      await removeProvider();
      await more?.();
    };
  };
  return { register, searches, calls, get disposed() { return disposed; } };
}

import { describe, expect, test } from "bun:test";
import type { Tool } from "@reins/sdk/server";
import { matchTools, toolSearchDocs } from "../../extensions/tool-docs.js";

const tool = (id: string, description: string, inputSchema: Tool["inputSchema"] = { type: "object" }): Tool =>
  ({ id, name: id.replace(/^\w+?__/, ""), description, inputSchema });

const typescript = (docs: string) => docs.slice(docs.indexOf("```typescript\n") + 14, docs.indexOf("```", docs.indexOf("```typescript\n") + 14));

describe("matchTools", () => {
  test("ranks the tools matching every term, a name match before a description match, a plural matching the singular", () => {
    const tools = [
      tool("vercel__list_deployments", "Lists a project's deployments."),
      tool("vercel__get_project", "Gets a project."),
      tool("vercel__list_teams", "Lists your teams."),
    ];
    const ids = (query: string) => matchTools(query, tools).map(match => match.id);

    expect(ids("project")).toEqual(["vercel__get_project", "vercel__list_deployments"]);
    expect(ids("deployment project")).toEqual(["vercel__list_deployments"]);
    expect(ids("projects")).toEqual(["vercel__get_project", "vercel__list_deployments"]);
    expect(ids("vercel")).toHaveLength(3);
    expect(ids("")).toHaveLength(3);
  });

  test("a query that is a tool's ID or name, in any case, puts that tool first", () => {
    const tools = [
      tool("vercel__list_deployments_all", "Like list_deployments, for every team."),
      tool("vercel__list_deployments", "Lists a project's deployments."),
    ];
    const first = (query: string) => matchTools(query, tools)[0]!.id;

    expect(first("vercel__list_deployments")).toBe("vercel__list_deployments");
    expect(first("LIST_DEPLOYMENTS")).toBe("vercel__list_deployments");
    expect(first(" list_deployments ")).toBe("vercel__list_deployments");
  });
});

describe("toolSearchDocs", () => {
  test("documents each provider's tools as a TypeScript interface keyed by ID, to call through api.tools.call", () => {
    const docs = toolSearchDocs([{
      title: "MCP servers",
      tools: [tool("vercel__list_deployments", "Lists a project's deployments.\nNewest first.", {
        type: "object",
        properties: {
          projectId: { type: "string", description: "The project's ID." },
          limit: { type: "integer" },
        },
        required: ["projectId"],
      })],
    }], "deployments");

    expect(docs).toStartWith(`Call a tool with api.tools.call(id, args), by its ID.\n\nMCP servers: 1 tool matches "deployments".`);
    expect(typescript(docs)).toBe(`interface Tools {
  /**
   * Lists a project's deployments.
   * Newest first.
   */
  vercel__list_deployments(args: {
    /** The project's ID. */
    projectId: string;
    limit?: number;
  }): Promise<ToolResult>;
}
`);
    expect(docs).toEndWith(`\`\`\`typescript
interface ToolResult {
  /** Content blocks, e.g. { type: "text", text }. */
  content: unknown[];
  structuredContent?: unknown;
  /** True when the tool reports a failure: its content says why. */
  isError?: boolean;
}
\`\`\``);
  });

  test("renders the JSON Schema that MCP servers use", () => {
    const docs = typescript(toolSearchDocs([{
      title: "MCP servers",
      tools: [{
        id: "github__search-issues_v2",
        name: "search-issues.v2",
        title: "Search issues",
        description: "Searches issues.",
        annotations: { readOnlyHint: true },
        inputSchema: {
          type: "object",
          properties: {
            state: { enum: ["open", "closed"] },
            label: { type: ["string", "null"] },
            sort: { oneOf: [{ const: "created" }, { const: 1 }] },
            filter: { $ref: "#/$defs/Filter" },
            labels: { type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }] } },
            extra: { type: "object", additionalProperties: { type: "boolean" } },
            "per-page": { allOf: [{ type: "object", properties: { a: { type: "string" } } }, { type: "object", properties: { b: { type: "number" } } }] },
          },
          $defs: { Filter: { type: "object", properties: { author: { type: "string" }, next: { $ref: "#/$defs/Filter" } } } },
        },
        outputSchema: { type: "object", properties: { total: { type: "number" } }, required: ["total"] },
      }],
    }], ""));

    expect(docs).toBe(`interface Tools {
  /**
   * Search issues: Searches issues.
   * Read-only.
   */
  "github__search-issues_v2"(args?: {
    state?: "open" | "closed";
    label?: string | null;
    sort?: "created" | 1;
    filter?: { author?: string; next?: unknown };
    labels?: (string | number)[];
    extra?: Record<string, boolean>;
    "per-page"?: { a?: string } & { b?: number };
  }): Promise<ToolResult & { structuredContent: { total: number } }>;
}
`);
  });

  test("past the first ten matches of a provider, names the others; with no query and many tools, names them all", () => {
    const tools = Array.from({ length: 12 }, (_, i) => tool(`vercel__deploy_${i}`, "Deploys."));

    const matched = toolSearchDocs([{ title: "MCP servers", tools }], "deploy");
    const unqueried = toolSearchDocs([{ title: "MCP servers", tools }], "");

    expect(matched).toContain(`MCP servers: 12 tools match "deploy".`);
    expect(matched).toContain("Also matching, not shown: vercel__deploy_10, vercel__deploy_11. Narrow the query to see them.");
    expect(unqueried).toBe(`Call a tool with api.tools.call(id, args), by its ID.\n\nMCP servers: 12 tools. Give a query to see their arguments.\n\n${tools.map(t => t.id).join(", ")}`);
  });

  test("groups by provider, in order, a failed provider in its place, and leaves out a provider with no match", () => {
    const docs = toolSearchDocs([
      { title: "First", tools: [tool("a__echo", "Echoes.")] },
      { title: "Empty", tools: [] },
      { title: "Broken", error: "vercel needs sign-in" },
      { title: "Second", tools: [tool("b__echo", "Echoes too.")] },
    ], "echo");

    expect(docs.indexOf("First: 1 tool")).toBeLessThan(docs.indexOf("Broken: vercel needs sign-in"));
    expect(docs.indexOf("Broken: vercel needs sign-in")).toBeLessThan(docs.indexOf("Second: 1 tool"));
    expect(docs).not.toContain("Empty");
  });

  test("nothing matching says so", () => {
    expect(toolSearchDocs([{ title: "MCP servers", tools: [] }], "deploy")).toBe(`No tool matches "deploy". Try fewer or other words.`);
    expect(toolSearchDocs([], "")).toBe("No tools.");
  });
});

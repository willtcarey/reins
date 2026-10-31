import { describe, expect, test } from "bun:test";
import type { McpTool } from "../../../extensions/mcp/connections.js";
import { mcpToolDocs } from "../../../extensions/mcp/tool-docs.js";

const tool = (name: string, description: string, inputSchema: McpTool["inputSchema"] = { type: "object" }): McpTool =>
  ({ name, description, inputSchema });

const typescript = (docs: string) => docs.slice(docs.indexOf("```typescript\n") + 14, docs.lastIndexOf("```"));

describe("mcpToolDocs", () => {
  test("documents the matching tools as a TypeScript interface to call through api.mcp.call", () => {
    const docs = mcpToolDocs("vercel", [
      tool("list_deployments", "Lists a project's deployments.\nNewest first.", {
        type: "object",
        properties: {
          projectId: { type: "string", description: "The project's ID." },
          limit: { type: "integer" },
        },
        required: ["projectId"],
      }),
      tool("list_teams", "Lists your teams."),
    ], "deployments");

    expect(docs).toStartWith(`vercel: 1 of 2 tools matches "deployments". Call one with api.mcp.call("vercel", tool, args).`);
    expect(typescript(docs)).toBe(`interface VercelTools {
  /**
   * Lists a project's deployments.
   * Newest first.
   */
  list_deployments(args: {
    /** The project's ID. */
    projectId: string;
    limit?: number;
  }): Promise<McpToolResult>;
}

interface McpToolResult {
  /** Content blocks, e.g. { type: "text", text }. */
  content: unknown[];
  structuredContent?: unknown;
  /** True when the tool reports a failure: its content says why. */
  isError?: boolean;
}
`);
  });

  test("ranks the tools matching every term, a name match before a description match, a plural matching the singular", () => {
    const tools = [
      tool("list_deployments", "Lists a project's deployments."),
      tool("get_project", "Gets a project."),
      tool("list_teams", "Lists your teams."),
    ];
    const shown = (query: string) => [...mcpToolDocs("vercel", tools, query).matchAll(/^ {2}(\w+)\(/gm)].map(m => m[1]);

    expect(shown("project")).toEqual(["get_project", "list_deployments"]);
    expect(shown("deployment project")).toEqual(["list_deployments"]);
    expect(shown("projects")).toEqual(["get_project", "list_deployments"]);
  });

  test("renders the JSON Schema that MCP servers use", () => {
    const docs = typescript(mcpToolDocs("github", [{
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
    }]));

    expect(docs).toContain(`interface GithubTools {
  /**
   * Search issues: Searches issues.
   * Read-only.
   */
  "search-issues.v2"(args?: {
    state?: "open" | "closed";
    label?: string | null;
    sort?: "created" | 1;
    filter?: { author?: string; next?: unknown };
    labels?: (string | number)[];
    extra?: Record<string, boolean>;
    "per-page"?: { a?: string } & { b?: number };
  }): Promise<McpToolResult & { structuredContent: { total: number } }>;
}`);
  });

  test("past the first ten matches, names the others; with no query and many tools, names them all", () => {
    const tools = Array.from({ length: 12 }, (_, i) => tool(`deploy_${i}`, "Deploys."));

    const matched = mcpToolDocs("vercel", tools, "deploy");
    const unqueried = mcpToolDocs("vercel", tools);

    expect(matched).toStartWith(`vercel: 12 of 12 tools match "deploy". Call one with api.mcp.call("vercel", tool, args).`);
    expect(matched).toContain("Also matching, not shown: deploy_10, deploy_11. Narrow the query to see them.");
    expect(unqueried).toBe(`vercel has 12 tools. Give a query to see their arguments, e.g. api.mcp.tools("vercel", "deploy_0").\n\n${tools.map(t => t.name).join(", ")}`);
  });

  test("a few tools are documented whole without a query; none matching names them all", () => {
    const tools = [tool("echo", "Echoes."), tool("list_projects", "Lists projects.")];

    expect(mcpToolDocs("tools", tools)).toStartWith(`tools: 2 tools. Call one with api.mcp.call("tools", tool, args).`);
    expect(mcpToolDocs("tools", tools, "deploy")).toBe(`No tool of tools matches "deploy". Its tools: echo, list_projects`);
  });
});

/**
 * `api.tools`: the tools extensions give agents (docs/dev/server-sdk.md *Tools*), found with `search` and run
 * with `call`, by the ID a source gave. The sources are asked at each search and each call.
 */

import { Type } from "@sinclair/typebox";
import { toolSearchDocs } from "../extensions/tool-docs.js";
import { type ApiContext, type ApiFunctionDef, defineFunction } from "./define-function.js";

export const ToolResultSchema = Type.Object({
  content: Type.Array(Type.Unknown(), { description: "Content blocks, e.g. { type: \"text\", text }." }),
  structuredContent: Type.Optional(Type.Unknown()),
  isError: Type.Optional(Type.Boolean({ description: "True when the tool itself reports a failure (its content says why)." })),
});

/** The script's signal, or one that never aborts. */
const signalOf = (ctx: ApiContext) => ctx.signal ?? new AbortController().signal;

export const toolsSearchFunction = defineFunction({
  name: "tools.search",
  description:
    "Find tools that extensions give (such as MCP servers' tools): the documentation, as TypeScript, of those whose " +
    "ID, name, title, argument names or description match the query's words, best first, grouped by where they come " +
    "from, to call with tools.call. filters narrow the search; each source says which it takes (the system prompt " +
    "names them). Without a query, a source with many tools only names them. search does not list the tools themselves.\n\n" +
    "  return await api.tools.search(\"list deployments\");",
  parameters: Type.Object({
    query: Type.String({ description: "Words to look for, e.g. \"list deployments\"; any case. Empty for every tool the filters let through." }),
    filters: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Given to every source as it is, e.g. { server: \"vercel\" }." })),
  }),
  returns: Type.String(),
  async: true,
  tags: ["tools", "tool", "find", "search", "mcp", "integration", "schema"],
  execute: async (params, ctx) =>
    toolSearchDocs(await ctx.models.extensions.searchTools(params.query, params.filters ?? {}, signalOf(ctx)), params.query),
});

export const toolsCallFunction = defineFunction({
  name: "tools.call",
  description:
    "Call a tool by its ID (find it and its arguments with tools.search). Returns the tool's result; a failure the tool " +
    "reports is a result with isError, not a throw. Throws for an unknown ID, and when the tool cannot be run.\n\n" +
    "  const result = await api.tools.call(\"vercel__list_projects\", { teamId: \"team_123\" });\n" +
    "  return result.content[0].text;",
  parameters: Type.Object({
    id: Type.String({ description: "The tool's ID, as tools.search shows it." }),
    args: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Its arguments, as its documentation describes." })),
    timeoutMs: Type.Optional(Type.Number({ description: "How long to wait for it; the source's default otherwise." })),
  }),
  returns: ToolResultSchema,
  async: true,
  tags: ["tools", "tool", "call", "run", "invoke", "mcp"],
  execute: (params, ctx) =>
    ctx.models.extensions.callTool(params.id, params.args ?? {}, { signal: signalOf(ctx), ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }) }),
});

export const TOOLS_FUNCTIONS: ApiFunctionDef[] = [toolsSearchFunction, toolsCallFunction];

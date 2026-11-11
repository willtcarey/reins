/**
 * `tools`: the tools extensions give (docs/dev/server-sdk.md *Tools*), found with `search` and run with `call` by
 * their final IDs, `reins.tools`, for an extension and an agent's script alike. The providers are
 * asked at each search and each call. A script gets a search as TypeScript documentation (`toolSearchDocs`).
 */

import { Type } from "@sinclair/typebox";
import type { ScriptNamespace } from "@reins/sdk/server";
import { ToolResultSchema, toolSearchDocs } from "../extension-system/tool-docs.js";
import { SignalSchema, sdkMethod, signalOf, type CallContext } from "./declaration.js";

const FiltersSchema = Type.Record(Type.String(), Type.Unknown(), {
  description: "Given to every provider as they are, e.g. { server: \"vercel\" }; each provider decides what its keys mean (the system prompt says which it takes).",
});

/** The calling session, as providers are told it; an extension calls as none. */
const callingSession = ({ caller }: CallContext): string | null => caller.kind === "session" ? caller.session.id : null;

const search = sdkMethod({
  description:
    "Find tools that extensions give (such as MCP servers' tools): the documentation, as TypeScript, of those whose " +
    "ID, name, title, argument names or description match the query's words, best first (a query that is a tool's ID or " +
    "name finds it first), grouped by where they come from, to call with tools.call. options.filters narrow the search. " +
    "Without a query, a provider with many tools only names them. search does not list the tools themselves.\n\n" +
    "  return await reins.tools.search(\"list deployments\", { filters: { server: \"vercel\" } });",
  params: [
    { name: "query", schema: Type.String({ description: "Words to look for, e.g. \"list deployments\"; any case. Empty for every tool the filters let through." }) },
    { name: "options", schema: Type.Object({ filters: Type.Optional(FiltersSchema), signal: Type.Optional(SignalSchema) }), optional: true },
  ],
  returns: Type.String(),
  tags: ["tools", "tool", "find", "search", "mcp", "integration", "schema"],
  run: (context, query, options = {}) => context.models.extensions.searchTools(query, options.filters ?? {}, signalOf(context, options.signal), callingSession(context)),
  toScript: (groups, query) => toolSearchDocs(groups, query),
});

const call = sdkMethod({
  description:
    "Call a tool by its ID, <extension>__<tool> (find it and its arguments with tools.search). Returns the tool's result; a failure the tool " +
    "reports is a result with isError, not a throw. Throws for an unknown ID, and when the tool cannot be run.\n\n" +
    "  const result = await reins.tools.call(\"mcp__vercel__list_projects\", { teamId: \"team_123\" });\n" +
    "  return result.content[0].text;",
  params: [
    { name: "id", schema: Type.String({ description: "The tool's ID, as tools.search shows it." }) },
    { name: "args", schema: Type.Record(Type.String(), Type.Unknown(), { description: "Its arguments, as its documentation describes." }), optional: true },
    {
      name: "options",
      schema: Type.Object({
        timeoutMs: Type.Optional(Type.Number({ description: "How long to wait for it; the provider's default otherwise." })),
        signal: Type.Optional(SignalSchema),
      }),
      optional: true,
    },
  ],
  returns: ToolResultSchema,
  tags: ["tools", "tool", "call", "run", "invoke", "mcp"],
  run: (context, id, args, options) => {
    const timeoutMs = options?.timeoutMs;
    return context.models.extensions.callTool(id, args ?? {}, { signal: signalOf(context, options?.signal), sessionId: callingSession(context), ...(timeoutMs === undefined ? {} : { timeoutMs }) });
  },
});

export const TOOLS = { namespace: "tools", methods: { search, call }, types: { ToolResult: ToolResultSchema } } satisfies ScriptNamespace<CallContext>;

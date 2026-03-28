/**
 * search Tool
 *
 * Discovers available functions and types for scripting Reins via the
 * `execute` tool. The agent describes what it wants to do, and the tool
 * returns matching function signatures, descriptions, and domain types.
 *
 * This keeps context lean — the agent only loads what it needs rather
 * than paying token cost for the full API spec on every call.
 */

import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { searchFunctions, referencedTypes, DOMAIN_TYPES, type ApiFunctionDef } from "../scripting/api-registry.js";
import { formatFunctionSignature, formatSchema, type SchemaNameMap } from "../scripting/api-schema-formatter.js";

const parameters = Type.Object({
  query: Type.String({
    description:
      "What you're looking for — a category (e.g. \"tasks\"), a function name " +
      "(e.g. \"sessions.messages\"), or a description (e.g. \"create task\"). " +
      "Use an empty string to see the full API surface.",
  }),
});

/** Build a map from schema identity → display name for all domain types. */
function buildNameMap(): SchemaNameMap {
  const names: SchemaNameMap = new Map();
  for (const dt of DOMAIN_TYPES) {
    names.set(dt.schema, dt.name);
  }
  return names;
}

/**
 * Format search results into a readable text block for the agent.
 * Includes function signatures, descriptions, and referenced type definitions.
 */
function formatResults(fns: ApiFunctionDef[]): string {
  if (fns.length === 0) {
    return "No matching API functions found. Try a broader query, or use an empty string to see the full API surface.";
  }

  const names = buildNameMap();

  // Render function signatures + descriptions
  const fnBlocks = fns.map((fn) => {
    const sig = formatFunctionSignature(fn.name, fn.parameters, fn.returns, { async: fn.async, names });
    return `## ${fn.name}\n\n${fn.description}\n\n\`\`\`typescript\n${sig}\n\`\`\``;
  });

  // Render referenced domain types
  const types = referencedTypes(fns);
  if (types.length > 0) {
    const typeBlocks = types.map((t) => formatSchema(t.schema, t.name));
    fnBlocks.push("## Types\n\n```typescript\n" + typeBlocks.join("\n\n") + "\n```");
  }

  return fnBlocks.join("\n\n---\n\n");
}

export function createSearchTool(): ToolDefinition<typeof parameters> {
  return {
    name: "search",
    label: "Search API",
    description:
      "Discover available API functions for the `execute` tool. " +
      "Returns function signatures and documentation filtered by your query. " +
      "Use this before writing execute scripts to find the right functions.",
    parameters,

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const results = searchFunctions(params.query);
      const text = formatResults(results);

      return {
        content: [{ type: "text" as const, text }],
        details: { matchCount: results.length },
      };
    },
  };
}

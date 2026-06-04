/**
 * search Tool
 *
 * Discovers available functions and types for scripting Reins via the
 * `execute` tool. The agent describes what it wants to do, and the tool
 * returns matching TypeScript documentation interfaces and domain types.
 *
 * This keeps context lean — the agent only loads what it needs rather
 * than paying token cost for the full API spec on every call.
 */

import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { searchFunctions, referencedTypes, DOMAIN_TYPES } from "../scripting/api-registry.js";
import type { ApiFunctionDef } from "../scripting/define-function.js";
import { formatApiInterfaces, formatTypeDeclaration, type SchemaNameMap } from "../scripting/api-schema-formatter.js";

const parameters = Type.Object({
  query: Type.String({
    description:
      "What you're looking for — a category, function name, or description. " +
      "Use an empty string to inspect the full API surface.",
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

  const apiInterfaces = formatApiInterfaces(fns, { names });
  const typeDeclarations = referencedTypes(fns)
    .map((type) => formatTypeDeclaration(type.schema, type.name, names));
  const code = [apiInterfaces, ...typeDeclarations].join("\n\n");

  return [
    "## API documentation",
    "",
    "Documentation only: these TypeScript interfaces describe the existing `api` object " +
      "available inside `execute` scripts. They may be partial: only functions matched by " +
      "this search are shown. Do not construct or import `Api`; call methods positionally " +
      "on the provided `api`, e.g. `api.tasks.update(taskId, updates)`.",
    "",
    "```typescript",
    code,
    "```",
  ].join("\n");
}

export function createSearchTool(): ToolDefinition<typeof parameters> {
  return {
    name: "search",
    label: "Search API",
    description:
      "Discover Reins internal API functions available to the `execute` tool. " +
      "Returns documentation-only TypeScript interfaces for the existing `api` object " +
      "and referenced domain types, filtered by query. " +
      "Use this before writing `execute` scripts for Reins-managed data or UI state. " +
      "Use an empty query to inspect the full API surface. " +
      "In `execute` scripts, call methods on the provided `api` object; " +
      "these interfaces are documentation only.",
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

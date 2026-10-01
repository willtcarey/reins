/**
 * Server side of the `search` agent tool (`script.search`).
 *
 * Discovers available functions and types for scripting Reins via the `execute` tool. The agent
 * describes what it wants to do, and the server returns matching TypeScript documentation
 * interfaces and domain types from the scripting API registry.
 *
 * This keeps context lean — the agent only loads what it needs rather than paying token cost for
 * the full API spec on every call.
 */

import type { ScriptSearchResult } from "@reins/node-protocol";
import { searchFunctions, referencedTypes, DOMAIN_TYPES } from "../scripting/api-registry.js";
import type { ApiFunctionDef } from "../scripting/define-function.js";
import { formatApiInterfaces, formatTypeDeclaration, type SchemaNameMap } from "../scripting/api-schema-formatter.js";

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

export function searchScriptApi(query: string): ScriptSearchResult {
  const results = searchFunctions(query);
  return { text: formatResults(results), matchCount: results.length };
}

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

import { searchFunctions, referencedTypes, scriptingApi, type NamedType } from "../sdk-host/scripts.js";
import type { ExtensionHost } from "../extension-system/host.js";
import type { ScriptFunction } from "../sdk-host/projection.js";
import { formatApiInterfaces, formatTypeDeclaration, type SchemaNameMap } from "../sdk-host/schema-formatter.js";

/** Build a map from schema identity → display name for all domain types. */
function buildNameMap(types: readonly NamedType[]): SchemaNameMap {
  const names: SchemaNameMap = new Map();
  for (const dt of types) {
    names.set(dt.schema, dt.name);
  }
  return names;
}

/**
 * Format search results into a readable text block for the agent.
 * Includes function signatures, descriptions, and referenced type definitions.
 */
function formatResults(fns: ScriptFunction[], types: readonly NamedType[]): string {
  if (fns.length === 0) {
    return "No matching API functions found. Try a broader query, or use an empty string to see the full API surface.";
  }

  const names = buildNameMap(types);

  const apiInterfaces = formatApiInterfaces(fns, { names });
  const typeDeclarations = referencedTypes(fns, types)
    .map((type) => formatTypeDeclaration(type.schema, type.name, names));
  const code = [apiInterfaces, ...typeDeclarations].join("\n\n");

  return [
    "## API documentation",
    "",
    "Documentation only: these TypeScript interfaces describe the existing `reins` object " +
      "available inside `execute` scripts. They may be partial: only functions matched by " +
      "this search are shown. Do not construct or import `Reins`; call methods positionally " +
      "on the provided `reins`, e.g. `reins.tasks.update(taskId, updates)`.",
    "",
    "```typescript",
    code,
    "```",
  ].join("\n");
}

export interface ScriptSearchResult { text: string; matchCount: number }

/** Searches the core's API, and that of the app's extensions when given. */
export function searchScriptApi(query: string, extensions?: ExtensionHost): ScriptSearchResult {
  const { functions, types } = scriptingApi(extensions);
  const results = searchFunctions(query, functions);
  return { text: formatResults(results, types), matchCount: results.length };
}

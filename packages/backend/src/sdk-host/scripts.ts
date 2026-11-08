/**
 * `reins` as scripts have it, and what `search` finds in it: the core's SDK namespaces (`namespaces.ts`) and the
 * app's extensions', each method projected from its declaration (`projection.ts`): its schemas are the single
 * source of truth, which `search` renders, with no hand-kept signatures.
 */

import type { TSchema } from "@sinclair/typebox";
import { scriptCallContext, scriptFunctions, scriptTypes, type ApiContext, type ScriptFunction } from "./projection.js";
import {
  schemaItems,
  schemaAnyOf,
  schemaProperties,
  sameSchema,
} from "./schema-utils.js";
import { rankByTerms } from "./term-search.js";
import type { ExtensionHost } from "../extension-system/host.js";
import { CORE_NAMESPACES } from "./namespaces.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Derive the namespace from a fully qualified function name (e.g. "tasks.list" → "tasks"). */
export function fnNamespace(fn: { name: string }): string {
  return fn.name.split(".")[0];
}

/** Derive the method name from a fully qualified function name (e.g. "tasks.list" → "list"). */
export function fnMethod(fn: { name: string }): string {
  return fn.name.split(".")[1];
}

// ---------------------------------------------------------------------------
// Named type registry (for search output)
// ---------------------------------------------------------------------------

export interface NamedType {
  name: string;
  schema: TSchema;
}

export const DOMAIN_TYPES: NamedType[] = CORE_NAMESPACES.flatMap(namespace => scriptTypes(namespace));

// ---------------------------------------------------------------------------
// Function registry: the SDK's namespaces, projected for scripts
// ---------------------------------------------------------------------------

export const API_FUNCTIONS: ScriptFunction[] = CORE_NAMESPACES.flatMap(namespace => scriptFunctions(namespace, scriptCallContext));

/** The `reins` an agent's scripts get: the core's functions and types, and those of the app's extensions. */
export interface ScriptingApi { functions: ScriptFunction[]; types: NamedType[] }

export function scriptingApi(extensions?: ExtensionHost): ScriptingApi {
  if (!extensions) return { functions: API_FUNCTIONS, types: DOMAIN_TYPES };
  return { functions: [...API_FUNCTIONS, ...extensions.scriptFunctions()], types: [...DOMAIN_TYPES, ...extensions.scriptTypes()] };
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Search the API registry by query string. Matches against name,
 * description, namespace, and tags. Prefer functions where every query
 * term matches at least one field. If no strict match exists for a multi-word
 * query, merge per-term matches so long natural-language queries still return
 * a useful partial API surface.
 *
 * Returns matching function definitions sorted by relevance.
 */
export function searchFunctions(query: string, functions: readonly ScriptFunction[] = API_FUNCTIONS): ScriptFunction[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map(normalizeSearchTerm)
    .filter((t) => t.length > 0);

  if (terms.length === 0) return [...functions];

  return rankByTerms(functions, terms, (fn) => [
    { text: fn.name, weight: 10 },
    { text: fnNamespace(fn), weight: 5 },
    { text: fn.tags.join(" "), weight: 3 },
    { text: fn.description, weight: 1 },
  ]);
}

function normalizeSearchTerm(term: string): string {
  const withoutQuotes = term.replace(/^[`'"]+|[`'",;:]+$/g, "");
  const withoutCall = withoutQuotes.replace(/\(.*$/, "");
  return withoutCall.startsWith("reins.") ? withoutCall.slice("reins.".length) : withoutCall;
}

/**
 * Find domain types referenced by a set of function definitions.
 * A type is "referenced" if its schema appears in any function's
 * parameters or returns.
 */
export function referencedTypes(fns: ScriptFunction[], types: readonly NamedType[] = DOMAIN_TYPES): NamedType[] {
  const seen = new Set<string>();
  const result: NamedType[] = [];

  for (const fn of fns) {
    for (const dt of types) {
      if (seen.has(dt.name)) continue;
      if (schemaReferences(fn.parameters, dt.schema) || schemaReferences(fn.returns, dt.schema)) {
        seen.add(dt.name);
        result.push(dt);
      }
    }
  }

  return result;
}

/**
 * Check if a schema tree contains a reference to the target schema
 * (by identity — same object reference).
 */
function schemaReferences(schema: TSchema, target: TSchema): boolean {
  if (sameSchema(schema, target)) return true;

  // Array items
  const items = schemaItems(schema);
  if (schema.type === "array" && items) {
    if (schemaReferences(items, target)) return true;
  }

  // Union members
  const anyOf = schemaAnyOf(schema);
  if (anyOf) {
    for (const member of anyOf) {
      if (schemaReferences(member, target)) return true;
    }
  }

  // Object properties
  const props = schemaProperties(schema);
  if (schema.type === "object" && props) {
    for (const p of Object.values(props)) {
      if (schemaReferences(p, target)) return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Build runtime API object
// ---------------------------------------------------------------------------

/**
 * Build the `reins` object for agent scripts. Namespaces are derived
 * from the registry — each function becomes a method on its namespace,
 * called with the script's positional arguments (`tasks.update(taskId, updates)`).
 */
type ApiMethod = (...args: unknown[]) => unknown;

export function buildApiObject(ctx: ApiContext, functions: readonly ScriptFunction[] = API_FUNCTIONS): Record<string, Record<string, ApiMethod>> {
  const api: Record<string, Record<string, ApiMethod>> = {};
  for (const fn of functions) {
    const ns = fnNamespace(fn);
    api[ns] ??= {};
    api[ns][fnMethod(fn)] = (...args: unknown[]) => fn.call(args, ctx);
  }
  return api;
}

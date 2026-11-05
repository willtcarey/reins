/**
 * API Registry
 *
 * Curated API surface exposed to agents via execute/search tools.
 * Each function definition carries:
 * - TypeBox schemas for parameters and return type (for documentation)
 * - An execute function (for runtime)
 * - Description and tags (for search)
 *
 * The schemas are the single source of truth — search renders them,
 * no hand-maintained signature strings.
 *
 * Function definitions live in per-resource files (tasks.ts, sessions.ts,
 * projects.ts) and are assembled here into a single registry.
 *
 * Core types (ApiContext, ApiFunctionDef, defineFunction) live in
 * define-function.ts to avoid circular imports — import them from there.
 */

import type { TSchema } from "@sinclair/typebox";
import type { ApiContext, ApiFunctionDef } from "./define-function.js";
import {
  schemaItems,
  schemaAnyOf,
  schemaProperties,
  sameSchema,
} from "./schema-utils.js";
import { rankByTerms } from "./term-search.js";
import type { ExtensionHost } from "../extensions/host.js";
import { scriptFunctions, scriptTypes } from "../sdk-host/projection.js";
import { CORE_NAMESPACES } from "../sdk-host/namespaces.js";

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

export const DOMAIN_TYPES: NamedType[] = CORE_NAMESPACES.flatMap(scriptTypes);

// ---------------------------------------------------------------------------
// Function registry: the SDK's namespaces, projected for scripts
// ---------------------------------------------------------------------------

export const API_FUNCTIONS: ApiFunctionDef[] = CORE_NAMESPACES.flatMap(scriptFunctions);

/** The `api` an agent's scripts get: the core's functions and types, and those of the app's extensions. */
export interface ScriptingApi { functions: ApiFunctionDef[]; types: NamedType[] }

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
export function searchFunctions(query: string, functions: readonly ApiFunctionDef[] = API_FUNCTIONS): ApiFunctionDef[] {
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
  return withoutCall.startsWith("api.") ? withoutCall.slice(4) : withoutCall;
}

/**
 * Find domain types referenced by a set of function definitions.
 * A type is "referenced" if its schema appears in any function's
 * parameters or returns.
 */
export function referencedTypes(fns: ApiFunctionDef[], types: readonly NamedType[] = DOMAIN_TYPES): NamedType[] {
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
 * Build the `api` object for agent scripts. Namespaces are derived
 * from the registry — each function becomes a method on its namespace,
 * called with the script's positional arguments (`tasks.update(taskId, updates)`).
 */
type ApiMethod = (...args: unknown[]) => unknown;

export function buildApiObject(ctx: ApiContext, functions: readonly ApiFunctionDef[] = API_FUNCTIONS): Record<string, Record<string, ApiMethod>> {
  const api: Record<string, Record<string, ApiMethod>> = {};
  for (const fn of functions) {
    const ns = fnNamespace(fn);
    api[ns] ??= {};
    api[ns][fnMethod(fn)] = (...args: unknown[]) => fn.call(args, ctx);
  }
  return api;
}

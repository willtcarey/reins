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
 * define-function.ts to avoid circular imports — per-resource files
 * import from there, and this file re-exports for external consumers.
 */

import type { TSchema } from "@sinclair/typebox";
import type { ApiContext, ApiFunctionDef } from "./define-function.js";
import {
  schemaItems,
  schemaAnyOf,
  schemaProperties,
  schemaPropertyKeys,
} from "./schema-utils.js";
import { TASK_FUNCTIONS, TaskSchema } from "./tasks.js";
import {
  SESSION_FUNCTIONS,
  SessionSchema,
  SessionEntrySchema,
  MessageEntrySchema,
  ToolCallEntrySchema,
  ToolCallResultSchema,
} from "./sessions.js";
import { PROJECT_FUNCTIONS, ProjectSchema } from "./projects.js";
import { UI_FUNCTIONS } from "./ui.js";
import { MODEL_FUNCTIONS, ProviderInfoSchema, ModelInfoSchema } from "./models.js";

// Re-export core types from define-function.ts for backward compatibility
export type { ApiContext, ApiFunctionDef, TypedApiFunctionDef } from "./define-function.js";
export { defineFunction } from "./define-function.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Derive the namespace from a fully qualified function name (e.g. "tasks.list" → "tasks"). */
export function fnNamespace(fn: { name: string }): string {
  return fn.name.split(".")[0];
}

/** Derive the method name from a fully qualified function name (e.g. "tasks.list" ��� "list"). */
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

export const DOMAIN_TYPES: NamedType[] = [
  { name: "Task", schema: TaskSchema },
  { name: "Session", schema: SessionSchema },
  { name: "SessionEntry", schema: SessionEntrySchema },
  { name: "MessageEntry", schema: MessageEntrySchema },
  { name: "ToolCallEntry", schema: ToolCallEntrySchema },
  { name: "ToolCallResult", schema: ToolCallResultSchema },
  { name: "Project", schema: ProjectSchema },
  { name: "ProviderInfo", schema: ProviderInfoSchema },
  { name: "ModelInfo", schema: ModelInfoSchema },
];

// ---------------------------------------------------------------------------
// Function registry (assembled from per-resource files)
// ---------------------------------------------------------------------------

export const API_FUNCTIONS: ApiFunctionDef[] = [
  ...TASK_FUNCTIONS,
  ...SESSION_FUNCTIONS,
  ...PROJECT_FUNCTIONS,
  ...UI_FUNCTIONS,
  ...MODEL_FUNCTIONS,
];

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
export function searchFunctions(query: string): ApiFunctionDef[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map(normalizeSearchTerm)
    .filter((t) => t.length > 0);

  if (terms.length === 0) return [...API_FUNCTIONS];

  const strictResults = scoreFunctions(terms, { requireAllTerms: true });
  if (strictResults.length > 0 || terms.length === 1) {
    return strictResults.map((s) => s.fn);
  }

  // Long natural-language queries often mix terms that belong to different
  // functions (e.g. "sessions messages tasks list"). If no single function
  // matches every term, merge per-term matches so discovery still returns a
  // useful partial API surface instead of an empty result. When richer matches
  // exist, drop one-term matches to avoid broad terms like "list" pulling in
  // unrelated namespaces.
  const fallbackResults = scoreFunctions(terms, { requireAllTerms: false })
    .filter((s) => s.matchedTerms > 0);
  const maxMatchedTerms = Math.max(0, ...fallbackResults.map((s) => s.matchedTerms));
  const minMatchedTerms = maxMatchedTerms > 1 ? 2 : 1;

  return fallbackResults
    .filter((s) => s.matchedTerms >= minMatchedTerms)
    .map((s) => s.fn);
}

interface FunctionScore {
  fn: ApiFunctionDef;
  score: number;
  matchedTerms: number;
}

function normalizeSearchTerm(term: string): string {
  const withoutQuotes = term.replace(/^[`'"]+|[`'",;:]+$/g, "");
  const withoutCall = withoutQuotes.replace(/\(.*$/, "");
  return withoutCall.startsWith("api.") ? withoutCall.slice(4) : withoutCall;
}

function scoreFunctions(
  terms: string[],
  opts: { requireAllTerms: boolean },
): FunctionScore[] {
  return API_FUNCTIONS.map((fn) => {
    const nameLower = fn.name.toLowerCase();
    const nsLower = fnNamespace(fn).toLowerCase();
    const descLower = fn.description.toLowerCase();
    const tagsJoined = fn.tags.join(" ").toLowerCase();

    let score = 0;
    let matchedTerms = 0;

    for (const term of terms) {
      const nameMatch = nameLower.includes(term);
      const nsMatch = nsLower.includes(term);
      const tagMatch = tagsJoined.includes(term);
      const descMatch = descLower.includes(term);

      if (!nameMatch && !nsMatch && !tagMatch && !descMatch) {
        if (opts.requireAllTerms) return { fn, score: 0, matchedTerms: 0 };
        continue;
      }

      matchedTerms += 1;
      if (nameMatch) score += 10;
      if (nsMatch) score += 5;
      if (tagMatch) score += 3;
      if (descMatch) score += 1;
    }

    return { fn, score, matchedTerms };
  })
    .filter((s) => (opts.requireAllTerms ? s.matchedTerms === terms.length : s.matchedTerms > 0))
    .toSorted((a, b) => b.matchedTerms - a.matchedTerms || b.score - a.score);
}

/**
 * Find domain types referenced by a set of function definitions.
 * A type is "referenced" if its schema appears in any function's
 * parameters or returns.
 */
export function referencedTypes(fns: ApiFunctionDef[]): NamedType[] {
  const seen = new Set<string>();
  const result: NamedType[] = [];

  for (const fn of fns) {
    for (const dt of DOMAIN_TYPES) {
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
  if (schema === target) return true;

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
 * from the registry — each function becomes a method on its namespace.
 *
 * Parameters are mapped positionally from schema key order:
 *   tasks.get(taskId)  — schema has { taskId: number }
 *   tasks.update(taskId, updates) — schema has { taskId, updates }
 */
type ApiMethod = (...args: unknown[]) => unknown;

export function buildApiObject(ctx: ApiContext): Record<string, Record<string, ApiMethod>> {
  const api: Record<string, Record<string, ApiMethod>> = {};

  for (const fn of API_FUNCTIONS) {
    const ns = fnNamespace(fn);
    if (!api[ns]) api[ns] = {};

    const props = schemaPropertyKeys(fn.parameters);
    const methodName = fnMethod(fn);

    if (props.length === 0) {
      api[ns][methodName] = () => fn.execute({}, ctx);
    } else {
      api[ns][methodName] = (...args: unknown[]) => {
        const params: Record<string, unknown> = {};
        for (let i = 0; i < props.length; i++) {
          params[props[i]] = args[i];
        }
        return fn.execute(params, ctx);
      };
    }
  }

  return api;
}

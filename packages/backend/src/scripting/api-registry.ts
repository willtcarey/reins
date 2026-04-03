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
 */

import type { TSchema, TObject, TProperties, Static } from "@sinclair/typebox";
import type { Broadcast } from "../models/broadcast.js";
import type { ManagedSession } from "../state.js";
import {
  schemaItems,
  schemaAnyOf,
  schemaProperties,
  schemaPropertyKeys,
} from "./schema-utils.js";
import { TASK_FUNCTIONS, TaskSchema } from "./tasks.js";
import { SESSION_FUNCTIONS, SessionSchema, MessageSchema } from "./sessions.js";
import { PROJECT_FUNCTIONS, ProjectSchema } from "./projects.js";
import { UI_FUNCTIONS } from "./ui.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Runtime context passed to every API function's execute method.
 * Carries the project scope and shared state.
 */
export interface ApiContext {
  projectId: number;
  sessionId: string;
  taskId: number | null;
  broadcast: Broadcast;
  sessions: Map<string, ManagedSession>;
}

/**
 * A single function in the API registry (stored form).
 *
 * Uses method syntax for `execute` to enable bivariant parameter
 * checking — this lets defineFunction() widen generic types without
 * type assertions.
 */
export interface ApiFunctionDef {
  /** Fully qualified name, e.g. "tasks.list". Namespace is derived from the prefix before the dot. */
  name: string;
  /** Human-readable description */
  description: string;
  /** TypeBox schema for the function's parameters (Type.Object) */
  parameters: TObject<TProperties>;
  /** TypeBox schema for the return type */
  returns: TSchema;
  /** Whether the function is async */
  async?: boolean;
  /** Searchable tags (lowercase) */
  tags: string[];
  /** The actual implementation, called at runtime. Method syntax for bivariant checking. */
  execute(params: Record<string, unknown>, ctx: ApiContext): unknown;
}

/** Derive the namespace from a fully qualified function name (e.g. "tasks.list" → "tasks"). */
export function fnNamespace(fn: ApiFunctionDef): string {
  return fn.name.split(".")[0];
}

/** Derive the method name from a fully qualified function name (e.g. "tasks.list" → "list"). */
export function fnMethod(fn: ApiFunctionDef): string {
  return fn.name.split(".")[1];
}

/**
 * Define a single API function with full type inference.
 *
 * The generic parameters are inferred from the definition, ensuring:
 * - `execute` receives correctly-typed params (from the parameter schema)
 * - `execute` must return a value matching the return schema
 *
 * The result is widened to `ApiFunctionDef` for storage in arrays.
 * This works without type assertions because ApiFunctionDef.execute
 * uses method syntax (bivariant parameter checking).
 */
export function defineFunction<P extends TObject<TProperties>, R extends TSchema>(def: {
  name: string;
  description: string;
  parameters: P;
  returns: R;
  async?: boolean;
  tags: string[];
  execute: (params: Static<P>, ctx: ApiContext) => Static<R> | Promise<Static<R>>;
}): ApiFunctionDef {
  return def;
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
  { name: "Message", schema: MessageSchema },
  { name: "Project", schema: ProjectSchema },
];

// ---------------------------------------------------------------------------
// Function registry (assembled from per-resource files)
// ---------------------------------------------------------------------------

export const API_FUNCTIONS: ApiFunctionDef[] = [
  ...TASK_FUNCTIONS,
  ...SESSION_FUNCTIONS,
  ...PROJECT_FUNCTIONS,
  ...UI_FUNCTIONS,
];

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Search the API registry by query string. Matches against name,
 * description, namespace, and tags. Each query term must match at
 * least one field.
 *
 * Returns matching function definitions sorted by relevance.
 */
export function searchFunctions(query: string): ApiFunctionDef[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);

  if (terms.length === 0) return [...API_FUNCTIONS];

  const scored = API_FUNCTIONS.map((fn) => {
    const nameLower = fn.name.toLowerCase();
    const nsLower = fnNamespace(fn).toLowerCase();
    const descLower = fn.description.toLowerCase();
    const tagsJoined = fn.tags.join(" ");

    let score = 0;
    let allTermsMatch = true;

    for (const term of terms) {
      const nameMatch = nameLower.includes(term);
      const nsMatch = nsLower.includes(term);
      const tagMatch = tagsJoined.includes(term);
      const descMatch = descLower.includes(term);

      if (!nameMatch && !nsMatch && !tagMatch && !descMatch) {
        allTermsMatch = false;
        break;
      }

      if (nameMatch) score += 10;
      if (nsMatch) score += 5;
      if (tagMatch) score += 3;
      if (descMatch) score += 1;
    }

    return { fn, score, match: allTermsMatch };
  });

  return scored
    .filter((s) => s.match)
    .toSorted((a, b) => b.score - a.score)
    .map((s) => s.fn);
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

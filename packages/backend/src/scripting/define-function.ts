/**
 * API function definition helper.
 *
 * Extracted from api-registry.ts to break circular imports. Per-resource
 * files (tasks.ts, sessions.ts, models.ts, etc.) import defineFunction
 * from here instead of api-registry.ts. api-registry.ts re-exports it
 * for backward compatibility.
 */

import type { TSchema, TObject, TProperties, Static } from "@sinclair/typebox";
import type { Broadcast } from "../models/broadcast.js";
import type { ManagedSession } from "../state.js";

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
  encryptionSecret: Buffer;
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

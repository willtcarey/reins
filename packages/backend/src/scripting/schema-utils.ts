/**
 * Schema Utilities
 *
 * Helpers for accessing TypeBox/JSON Schema fields at runtime.
 * TypeBox's TSchema type is a discriminated union that doesn't expose
 * all JSON Schema fields (like `items`, `anyOf`, `properties`) on
 * every variant. These helpers index into the runtime object safely.
 *
 * All type assertions are confined to this module via Reflect.get
 * (which returns `any` that we immediately widen to `unknown`) and
 * type guard functions. Consumers get properly-typed accessors.
 */

import type { TSchema } from "@sinclair/typebox";

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

/** Runtime check: value is a non-null object (plausible TSchema). */
function isTSchema(value: unknown): value is TSchema {
  return value != null && typeof value === "object";
}

/** Runtime check: value is an array of plausible TSchema objects. */
function isTSchemaArray(value: unknown): value is TSchema[] {
  return Array.isArray(value);
}

/** Runtime check: value is a plain object of plausible TSchema values. */
function isTSchemaRecord(value: unknown): value is Record<string, TSchema> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Low-level field access
// ---------------------------------------------------------------------------

/**
 * Read a field from a schema's underlying JSON Schema object.
 *
 * Returns `unknown` — callers should prefer the typed accessors below.
 * Uses Reflect.get to access fields not present in TSchema's TS type.
 */
export function schemaField(schema: TSchema, key: string): unknown {
  const value: unknown = Reflect.get(schema, key);
  return value;
}

// ---------------------------------------------------------------------------
// Typed accessors
// ---------------------------------------------------------------------------

/** Get the `items` sub-schema from an array schema. */
export function schemaItems(schema: TSchema): TSchema | undefined {
  const items = schemaField(schema, "items");
  return isTSchema(items) ? items : undefined;
}

/** Get the `anyOf` members from a union schema. */
export function schemaAnyOf(schema: TSchema): TSchema[] | undefined {
  const anyOf = schemaField(schema, "anyOf");
  return isTSchemaArray(anyOf) ? anyOf : undefined;
}

/** Get the `properties` record from an object schema. */
export function schemaProperties(schema: TSchema): Record<string, TSchema> | undefined {
  const props = schemaField(schema, "properties");
  return isTSchemaRecord(props) ? props : undefined;
}

/** Get `properties` as [key, schema] entries. */
export function schemaPropertiesEntries(schema: TSchema): [string, TSchema][] {
  const props = schemaProperties(schema);
  if (!props) return [];
  return Object.entries(props);
}

/** Get the `required` field as a Set of property names. */
export function schemaRequiredSet(schema: TSchema): Set<string> {
  const req = schemaField(schema, "required");
  return new Set(Array.isArray(req) ? req : []);
}

/** Get the `const` value from a const schema. */
export function schemaConst(schema: TSchema): unknown {
  return schemaField(schema, "const");
}

// ---------------------------------------------------------------------------
// Derived helpers
// ---------------------------------------------------------------------------

/**
 * Get the property key names from an object schema.
 * Returns [] if the schema has no properties.
 */
export function schemaPropertyKeys(schema: TSchema): string[] {
  const props = schemaProperties(schema);
  if (!props) return [];
  return Object.keys(props);
}

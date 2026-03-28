/**
 * Schema Utilities
 *
 * Helpers for accessing TypeBox/JSON Schema fields at runtime.
 * TypeBox's TSchema type is a discriminated union that doesn't expose
 * all JSON Schema fields (like `items`, `anyOf`, `properties`) on
 * every variant. These helpers index into the runtime object safely.
 */

import type { TSchema } from "@sinclair/typebox";

/**
 * Read a field from a schema's underlying JSON Schema object.
 *
 * Returns `unknown` — callers narrow the type based on which field
 * they're reading (e.g., "items" → TSchema, "properties" → Record).
 */
export function schemaField(schema: TSchema, key: string): unknown {
  // TSchema objects are plain JSON Schema records at runtime.
  // Index via the string key to access fields not in the TS type.
  return (schema as Record<string, unknown>)[key]; // eslint-disable-line @typescript-eslint/consistent-type-assertions -- TSchema is a plain object at runtime; this is the only way to access JSON Schema fields not in the TS union
}

/**
 * Get the property key names from an object schema.
 * Returns [] if the schema has no properties.
 */
export function schemaPropertyKeys(schema: TSchema): string[] {
  const props = schemaField(schema, "properties");
  if (!props || typeof props !== "object") return [];
  return Object.keys(props);
}

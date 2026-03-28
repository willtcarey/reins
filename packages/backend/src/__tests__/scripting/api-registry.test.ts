/**
 * Tests for the API registry — structure, search, and schema constraints.
 */

import { describe, test, expect } from "bun:test";
import type { TSchema } from "@sinclair/typebox";
import { API_FUNCTIONS, DOMAIN_TYPES, fnNamespace } from "../../scripting/api-registry.js";
import { schemaField } from "../../scripting/schema-utils.js";

describe("API registry schema constraints", () => {
  /**
   * Every object schema in a function's `returns` tree must be either:
   * - A known domain type (identity-equal to a DOMAIN_TYPES schema)
   * - An empty object (Type.Object({}), used for empty params)
   *
   * This prevents accidental inline object schemas that wouldn't appear
   * as named types in search output.
   */
  test("all return schemas only reference domain types", () => {
    const domainSchemas = new Set(DOMAIN_TYPES.map((dt) => dt.schema));

    for (const fn of API_FUNCTIONS) {
      const violations = findNonDomainObjects(fn.returns, domainSchemas);
      if (violations.length > 0) {
        throw new Error(
          `${fn.name}: return schema contains inline object schema(s) not in DOMAIN_TYPES. ` +
            `Found ${violations.length} violation(s). Register them in DOMAIN_TYPES or use an existing domain type.`,
        );
      }
    }
  });

  test("all parameter schemas only reference domain types for nested objects", () => {
    const domainSchemas = new Set(DOMAIN_TYPES.map((dt) => dt.schema));

    for (const fn of API_FUNCTIONS) {
      // Skip the top-level params object itself — it's always an inline Type.Object
      // Only check nested objects within parameter properties
      const props = schemaField(fn.parameters, "properties");
      if (!props || typeof props !== "object") continue;

      for (const [key, propSchema] of Object.entries(props)) {
        const violations = findNonDomainObjects(propSchema as TSchema, domainSchemas, { allowTopLevelObject: true });
        if (violations.length > 0) {
          throw new Error(
            `${fn.name}: parameter "${key}" contains inline object schema(s) not in DOMAIN_TYPES. ` +
              `Found ${violations.length} violation(s).`,
          );
        }
      }
    }
  });

  test("every function has a unique name", () => {
    const names = API_FUNCTIONS.map((fn) => fn.name);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    expect(dupes).toEqual([]);
  });

  test("every function name matches namespace.method pattern", () => {
    for (const fn of API_FUNCTIONS) {
      expect(fn.name).toMatch(/^[a-z]+\.[a-zA-Z]+$/);
      // namespace is derived from the name prefix
      expect(fn.name.startsWith(fnNamespace(fn) + ".")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface WalkOptions {
  /** If true, allow the top-level schema to be an inline object (for param properties) */
  allowTopLevelObject?: boolean;
}

/**
 * Walk a schema tree and return any object sub-schemas that are not
 * identity-equal to a known domain type schema.
 */
function findNonDomainObjects(
  schema: TSchema,
  domainSchemas: Set<TSchema>,
  opts?: WalkOptions,
  depth = 0,
): TSchema[] {
  const violations: TSchema[] = [];

  // Check if this is an object schema
  if (schema.type === "object" && schemaField(schema, "properties")) {
    const isTopLevel = depth === 0 && opts?.allowTopLevelObject;
    const isEmpty = Object.keys((schemaField(schema, "properties") as object) ?? {}).length === 0;

    if (!isTopLevel && !isEmpty && !domainSchemas.has(schema)) {
      violations.push(schema);
    }

    // Recurse into object properties
    const properties = schemaField(schema, "properties");
    if (properties && typeof properties === "object") {
      for (const propSchema of Object.values(properties)) {
        violations.push(...findNonDomainObjects(propSchema as TSchema, domainSchemas, undefined, depth + 1));
      }
    }
  }

  // Array items
  const items = schemaField(schema, "items");
  if (schema.type === "array" && items) {
    violations.push(...findNonDomainObjects(items as TSchema, domainSchemas, undefined, depth + 1));
  }

  // Union members
  const anyOf = schemaField(schema, "anyOf");
  if (Array.isArray(anyOf)) {
    for (const member of anyOf) {
      violations.push(...findNonDomainObjects(member as TSchema, domainSchemas, undefined, depth + 1));
    }
  }

  return violations;
}

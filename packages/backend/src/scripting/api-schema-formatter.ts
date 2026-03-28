/**
 * API Schema Formatter
 *
 * Renders TypeBox schemas as readable text for agents. Produces
 * OpenAPI-like type descriptions and function signatures from the
 * schema objects — no hand-maintained strings.
 *
 * Works with the raw JSON Schema structure that TypeBox produces,
 * using schemaField() to access properties without type assertions.
 *
 * When a `names` map is provided, known domain types are rendered by
 * name (e.g. `Task`) instead of inlined as full object literals.
 */

import type { TSchema } from "@sinclair/typebox";
import {
  schemaItems,
  schemaAnyOf,
  schemaProperties,
  schemaPropertiesEntries,
  schemaRequiredSet,
  schemaConst,
} from "./schema-utils.js";

/**
 * A map from schema identity to its display name.
 * Used to render domain types by name instead of inlining them.
 */
export type SchemaNameMap = Map<TSchema, string>;

// ---------------------------------------------------------------------------
// Schema → readable string
// ---------------------------------------------------------------------------

/**
 * Render a TypeBox schema as a readable type string.
 *
 * When `name` is provided, renders as a named type block:
 *   `MyType { id: number, name: string }`
 *
 * Otherwise renders inline: `{ id: number, name: string }` or `string`.
 */
export function formatSchema(schema: TSchema, name?: string, names?: SchemaNameMap): string {
  const inline = renderType(schema, names);
  if (!name) return inline;

  // For object schemas, render as named block
  if (schema.type === "object" && schemaProperties(schema)) {
    const fields = renderObjectFields(schema, names);
    return `${name} {\n${fields}\n}`;
  }

  return `${name} = ${inline}`;
}

/**
 * Render a function signature from parameter and return schemas.
 */
export function formatFunctionSignature(
  name: string,
  params: TSchema,
  returns: TSchema,
  opts?: { async?: boolean; names?: SchemaNameMap },
): string {
  const paramStr = renderParams(params, opts?.names);
  const retStr = renderType(returns, opts?.names);
  const retType = opts?.async ? `Promise<${retStr}>` : retStr;
  return `${name}(${paramStr}): ${retType}`;
}

// ---------------------------------------------------------------------------
// Internal renderers
// ---------------------------------------------------------------------------

function renderType(schema: TSchema, names?: SchemaNameMap): string {
  // Check for a named type first (by identity)
  const knownName = names?.get(schema);
  if (knownName) return knownName;

  // Primitives
  const constVal = schemaConst(schema);
  if (schema.type === "string" && constVal !== undefined) {
    return JSON.stringify(constVal);
  }
  if (schema.type === "string") return "string";
  if (schema.type === "number" || schema.type === "integer") return "number";
  if (schema.type === "boolean") return "boolean";
  if (schema.type === "null") return "null";

  // Union (anyOf)
  const anyOf = schemaAnyOf(schema);
  if (anyOf) {
    const members = anyOf.map((s) => renderType(s, names));
    return members.join(" | ");
  }

  // Array
  const items = schemaItems(schema);
  if (schema.type === "array" && items) {
    const itemType = renderType(items, names);
    const needsParens = itemType.includes(" | ");
    return needsParens ? `(${itemType})[]` : `${itemType}[]`;
  }

  // Object
  if (schema.type === "object" && schemaProperties(schema)) {
    return renderObjectInline(schema, names);
  }

  // Empty object (no properties)
  if (schema.type === "object") return "{}";

  return "unknown";
}

function getProps(schema: TSchema): [string, TSchema][] {
  return schemaPropertiesEntries(schema);
}

function getRequiredSet(schema: TSchema): Set<string> {
  return schemaRequiredSet(schema);
}

function renderObjectInline(schema: TSchema, names?: SchemaNameMap): string {
  const props = getProps(schema);
  const required = getRequiredSet(schema);

  const parts = props.map(([key, propSchema]) => {
    const optional = !required.has(key);
    const type = renderType(propSchema, names);
    return `${key}${optional ? "?" : ""}: ${type}`;
  });

  return `{ ${parts.join(", ")} }`;
}

function renderObjectFields(schema: TSchema, names?: SchemaNameMap): string {
  const props = getProps(schema);
  const required = getRequiredSet(schema);

  return props
    .map(([key, propSchema]) => {
      const optional = !required.has(key);
      const type = renderType(propSchema, names);
      return `  ${key}${optional ? "?" : ""}: ${type}`;
    })
    .join("\n");
}

function renderParams(schema: TSchema, names?: SchemaNameMap): string {
  const props = getProps(schema);
  if (props.length === 0) return "";

  const required = getRequiredSet(schema);

  return props
    .map(([key, propSchema]) => {
      const optional = !required.has(key);
      const type = renderType(propSchema, names);
      return `${key}${optional ? "?" : ""}: ${type}`;
    })
    .join(", ");
}

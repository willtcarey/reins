/**
 * API Schema Formatter
 *
 * Renders TypeBox schemas as readable text for agents. Produces
 * valid TypeScript documentation interfaces and legacy function signatures
 * from the schema objects — no hand-maintained strings.
 *
 * Works with the raw JSON Schema structure that TypeBox produces,
 * using schemaField() to access properties without type assertions.
 *
 * When a `names` map is provided, known domain types are rendered by
 * name (e.g. `Task`) instead of inlined as full object literals.
 */

import type { TSchema } from "@sinclair/typebox";
import type { ApiFunctionDef } from "./define-function.js";
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

/**
 * Render matched API functions as partial TypeScript documentation interfaces.
 * Methods are grouped under namespace interfaces and use positional params,
 * matching the runtime `api.namespace.method(...args)` calling convention.
 */
export function formatApiInterfaces(
  fns: ApiFunctionDef[],
  opts?: { names?: SchemaNameMap },
): string {
  const groups = new Map<string, ApiFunctionDef[]>();

  for (const fn of fns) {
    const { namespace } = splitApiName(fn.name);
    const existing = groups.get(namespace);
    if (existing) {
      existing.push(fn);
    } else {
      groups.set(namespace, [fn]);
    }
  }

  const namespaceLines = [...groups.keys()].map(
    (namespace) => `  ${namespace}: ${namespaceInterfaceName(namespace)};`,
  );

  const rootInterface = [
    "interface Api {",
    ...namespaceLines,
    "}",
  ].join("\n");

  const namespaceInterfaces = [...groups.entries()].map(([namespace, groupFns]) => {
    const methodBlocks = groupFns.map((fn) => {
      const { method } = splitApiName(fn.name);
      const params = renderParams(fn.parameters, opts?.names);
      const ret = renderType(fn.returns, opts?.names);
      const retType = fn.async ? `Promise<${ret}>` : ret;
      return [
        renderJSDoc(fn.description, "  "),
        `  ${method}(${params}): ${retType};`,
      ].join("\n");
    });

    return [
      `interface ${namespaceInterfaceName(namespace)} {`,
      methodBlocks.join("\n\n"),
      "}",
    ].join("\n");
  });

  return [rootInterface, ...namespaceInterfaces].join("\n\n");
}

/** Render a named TypeBox schema as a valid TypeScript declaration. */
export function formatTypeDeclaration(
  schema: TSchema,
  name: string,
  names?: SchemaNameMap,
): string {
  if (schema.type === "object" && schemaProperties(schema)) {
    const fields = renderInterfaceFields(schema, names);
    return `interface ${name} {\n${fields}\n}`;
  }

  return `type ${name} = ${renderType(schema, names)};`;
}

// ---------------------------------------------------------------------------
// Internal renderers
// ---------------------------------------------------------------------------

function splitApiName(name: string): { namespace: string; method: string } {
  const [namespace, method] = name.split(".");
  return { namespace, method };
}

function namespaceInterfaceName(namespace: string): string {
  return `${namespace.charAt(0).toUpperCase()}${namespace.slice(1)}Api`;
}

function renderJSDoc(text: string, indent: string): string {
  const escaped = text.replace(/\*\//g, "*\\/").trim();
  if (!escaped.includes("\n")) return `${indent}/** ${escaped} */`;

  const lines = escaped.split(/\r?\n/);
  return [
    `${indent}/**`,
    ...lines.map((line) => `${indent} * ${line}`),
    `${indent} */`,
  ].join("\n");
}

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

function renderInterfaceFields(schema: TSchema, names?: SchemaNameMap): string {
  const props = getProps(schema);
  const required = getRequiredSet(schema);

  return props
    .map(([key, propSchema]) => {
      const optional = !required.has(key);
      const type = renderType(propSchema, names);
      return `  ${key}${optional ? "?" : ""}: ${type};`;
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

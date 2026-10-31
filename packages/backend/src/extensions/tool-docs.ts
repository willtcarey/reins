/**
 * Tools as agents find them (`api.tools.search`): matching a query (`matchTools`, also the SDK's
 * `tools.match`) and the answer, the matching tools as TypeScript documentation of `api.tools.call`, grouped
 * by tool provider (docs/dev/server-sdk.md *Tools*).
 */

import type { Tool } from "@reins/sdk/server";
import { rankByTerms } from "../scripting/term-search.js";

/** Documented whole, in each provider; the matches past it are only named. */
const DOCUMENTED_LIMIT = 10;
const NAMED_LIMIT = 200;
/** Deeper schemas are `unknown`: an agent rarely needs them, and they cost tokens. */
const MAX_DEPTH = 6;

const RESULT_DECLARATION = `interface ToolResult {
  /** Content blocks, e.g. { type: "text", text }. */
  content: unknown[];
  structuredContent?: unknown;
  /** True when the tool reports a failure: its content says why. */
  isError?: boolean;
}`;

/** What one provider answered a search: its tools, or why it could not. */
export type ToolSearchGroup = { title: string; tools: readonly Tool[] } | { title: string; error: string };

function terms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).map(term => singular(term.replace(/^[`'"]+|[`'",;:]+$/g, ""))).filter(Boolean);
}

/** The tools that match `query`, best first; all of them for an empty query. */
export function matchTools(query: string, tools: readonly Tool[]): Tool[] {
  const words = terms(query);
  if (words.length === 0) return [...tools];
  const exact = query.trim().toLowerCase();
  const ranked = rankByTerms(tools, words, tool => [
    { text: `${tool.id} ${tool.name}`, weight: 10 },
    { text: tool.title ?? "", weight: 5 },
    { text: Object.keys(record(record(tool.inputSchema).properties)).join(" "), weight: 3 },
    { text: tool.description ?? "", weight: 1 },
  ]);
  const isExact = (tool: Tool) => tool.id.toLowerCase() === exact || tool.name.toLowerCase() === exact;
  return [...ranked.filter(isExact), ...ranked.filter(tool => !isExact(tool))];
}

/** `api.tools.search`'s answer: each provider's tools, the first of each documented and the others named. */
export function toolSearchDocs(groups: readonly ToolSearchGroup[], query: string): string {
  const quoted = JSON.stringify(query);
  const searched = terms(query).length > 0;
  let documented = false;
  const parts = groups.flatMap(group => {
    if ("error" in group) return [`${group.title}: ${group.error}`];
    const { tools } = group;
    if (tools.length === 0) return [];
    const count = `${tools.length} tool${tools.length === 1 ? "" : "s"}`;
    if (!searched && tools.length > DOCUMENTED_LIMIT) {
      return [`${group.title}: ${count}. Give a query to see their arguments.\n\n${names(tools)}`];
    }
    documented = true;
    const shown = tools.slice(0, DOCUMENTED_LIMIT);
    const rest = tools.slice(DOCUMENTED_LIMIT);
    const head = searched ? `${group.title}: ${count} ${tools.length === 1 ? "matches" : "match"} ${quoted}.` : `${group.title}: ${count}.`;
    const tail = rest.length > 0 ? `\n\nAlso matching, not shown: ${names(rest)}. Narrow the query to see them.` : "";
    return [`${head}\n\n${documentation(shown)}${tail}`];
  });
  if (parts.length === 0) return searched ? `No tool matches ${quoted}. Try fewer or other words.` : "No tools.";
  const footer = documented ? [`\`\`\`typescript\n${RESULT_DECLARATION}\n\`\`\``] : [];
  return ["Call a tool with api.tools.call(id, args), by its ID.", ...parts, ...footer].join("\n\n");
}

// Tool names are often singular where a query is plural ("list deployments", get_deployment).
function singular(term: string): string {
  return term.length > 3 && term.endsWith("s") && !term.endsWith("ss") ? term.slice(0, -1) : term;
}

function names(tools: readonly Tool[]): string {
  const shown = tools.slice(0, NAMED_LIMIT).map(tool => tool.id).join(", ");
  return tools.length > NAMED_LIMIT ? `${shown}, and ${tools.length - NAMED_LIMIT} more` : shown;
}

function documentation(tools: readonly Tool[]): string {
  const methods = tools.map(tool => {
    const schema = new SchemaRenderer(tool.inputSchema);
    const doc = toolDoc(tool);
    const args = schema.params();
    const output = tool.outputSchema ? ` & { structuredContent: ${new SchemaRenderer(tool.outputSchema).root()} }` : "";
    return `${doc ? `${jsDoc(doc, "  ")}\n` : ""}  ${key(tool.id)}(${args}): Promise<ToolResult${output}>;`;
  });
  return `\`\`\`typescript\ninterface Tools {\n${methods.join("\n")}\n}\n\`\`\``;
}

function toolDoc(tool: Tool): string {
  const description = tool.description?.trim() ?? "";
  const title = tool.title?.trim();
  const lines = [title && title !== tool.name ? (description ? `${title}: ${description}` : title) : description];
  if (tool.annotations?.readOnlyHint) lines.push("Read-only.");
  else if (tool.annotations?.destructiveHint) lines.push("Destructive.");
  return lines.filter(Boolean).join("\n");
}

function key(name: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
}

function jsDoc(text: string, indent: string): string {
  const lines = text.replace(/\*\//g, "*\\/").trim().split(/\r?\n/);
  if (lines.length === 1) return `${indent}/** ${lines[0]} */`;
  return [`${indent}/**`, ...lines.map(line => `${indent} *${line ? ` ${line}` : ""}`), `${indent} */`].join("\n");
}

type Schema = Record<string, unknown>;

function isSchema(value: unknown): value is Schema {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown): Schema {
  return isSchema(value) ? value : {};
}

/** JSON Schema as a TypeScript type, `$ref`s into the root's `$defs`/`definitions` inlined. */
class SchemaRenderer {
  private readonly refs: string[] = [];

  constructor(private readonly rootSchema: unknown) {}

  root(): string {
    return this.type(this.rootSchema, 0);
  }

  /** The tool's `args` parameter, its fields one per line with their descriptions. */
  params(): string {
    const schema = record(this.rootSchema);
    const properties = Object.entries(record(schema.properties));
    if (properties.length === 0) return "args?: {}";
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const fields = properties.map(([name, property]) => {
      const description = record(property).description;
      const doc = typeof description === "string" && description.trim() ? `${jsDoc(description, "    ")}\n` : "";
      return `${doc}    ${key(name)}${required.has(name) ? "" : "?"}: ${this.type(property, 1)};`;
    });
    return `args${required.size > 0 ? "" : "?"}: {\n${fields.join("\n")}\n  }`;
  }

  private type(value: unknown, depth: number): string {
    if (value === true) return "unknown";
    const schema = record(value);
    if (depth > MAX_DEPTH) return "unknown";

    if (typeof schema.$ref === "string") return this.ref(schema.$ref, depth);
    if ("const" in schema) return JSON.stringify(schema.const);
    if (Array.isArray(schema.enum)) return schema.enum.map(member => JSON.stringify(member)).join(" | ");
    for (const keyword of ["anyOf", "oneOf"] as const) {
      const members = schema[keyword];
      if (Array.isArray(members)) return unique(members.map(member => this.type(member, depth + 1))).join(" | ");
    }
    if (Array.isArray(schema.allOf)) {
      return schema.allOf.map(member => parenthesized(this.type(member, depth + 1))).join(" & ");
    }

    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const rendered = unique(types.map(type => this.primitive(type, schema, depth)));
    if (schema.nullable === true && !rendered.includes("null")) rendered.push("null");
    return rendered.join(" | ");
  }

  private primitive(type: unknown, schema: Schema, depth: number): string {
    switch (type) {
      case "string": return "string";
      case "number": case "integer": return "number";
      case "boolean": return "boolean";
      case "null": return "null";
      case "array": {
        if (!("items" in schema) || Array.isArray(schema.items)) return "unknown[]";
        return `${parenthesized(this.type(schema.items, depth + 1))}[]`;
      }
      case "object": return this.object(schema, depth);
      default: return "properties" in schema ? this.object(schema, depth) : "unknown";
    }
  }

  private object(schema: Schema, depth: number): string {
    const properties = Object.entries(record(schema.properties));
    const extra = schema.additionalProperties;
    const extraType = extra && extra !== true ? this.type(extra, depth + 1) : null;
    if (properties.length === 0) return `Record<string, ${extraType ?? "unknown"}>`;
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const fields = properties.map(([name, property]) => `${key(name)}${required.has(name) ? "" : "?"}: ${this.type(property, depth + 1)}`);
    if (extraType) fields.push(`[key: string]: ${extraType}`);
    return `{ ${fields.join("; ")} }`;
  }

  /** A reference back into one being rendered (a recursive type) is `unknown`. */
  private ref(ref: string, depth: number): string {
    const match = /^#\/(\$defs|definitions)\/(.+)$/.exec(ref);
    const target = match ? record(record(record(this.rootSchema)[match[1]!])[match[2]!]) : null;
    if (!target || Object.keys(target).length === 0 || this.refs.includes(ref)) return "unknown";
    this.refs.push(ref);
    try { return this.type(target, depth + 1); } finally { this.refs.pop(); }
  }
}

function unique(types: string[]): string[] {
  return [...new Set(types)];
}

function parenthesized(type: string): string {
  return type.includes(" | ") || type.includes(" & ") ? `(${type})` : type;
}

/**
 * `api.mcp.tools`' answer: a server's tools that match a query, as TypeScript documentation of the calls an
 * agent makes through `api.mcp.call` (docs/dev/mcp-servers.md *Exposing tools to agents*).
 */

import type { McpTool } from "../mcp/connections.js";
import { rankByTerms } from "./term-search.js";

/** Documented whole; the matches past it are only named. */
const DOCUMENTED_LIMIT = 10;
const NAMED_LIMIT = 200;
/** Deeper schemas are `unknown`: an agent rarely needs them, and they cost tokens. */
const MAX_DEPTH = 6;

const RESULT_DECLARATION = `interface McpToolResult {
  /** Content blocks, e.g. { type: "text", text }. */
  content: unknown[];
  structuredContent?: unknown;
  /** True when the tool reports a failure: its content says why. */
  isError?: boolean;
}`;

export function mcpToolDocs(server: string, tools: readonly McpTool[], query = ""): string {
  const terms = query.toLowerCase().split(/\s+/).map(term => singular(term.replace(/^[`'"]+|[`'",;:]+$/g, ""))).filter(Boolean);
  const call = `Call one with api.mcp.call(${JSON.stringify(server)}, tool, args).`;

  if (terms.length === 0) {
    if (tools.length > DOCUMENTED_LIMIT) {
      return `${server} has ${tools.length} tools. Give a query to see their arguments, e.g. ` +
        `api.mcp.tools(${JSON.stringify(server)}, ${JSON.stringify(tools[0]!.name)}).\n\n${names(tools)}`;
    }
    if (tools.length === 0) return `${server} has no tools.`;
    return `${server}: ${tools.length} tool${tools.length === 1 ? "" : "s"}. ${call}\n\n${documentation(server, tools)}`;
  }

  const matches = rankByTerms(tools, terms, tool => [
    { text: tool.name, weight: 10 },
    { text: tool.title ?? "", weight: 5 },
    { text: Object.keys(record(tool.inputSchema.properties)).join(" "), weight: 3 },
    { text: tool.description ?? "", weight: 1 },
  ]);
  if (matches.length === 0) return `No tool of ${server} matches ${JSON.stringify(query)}. Its tools: ${names(tools)}`;

  const documented = matches.slice(0, DOCUMENTED_LIMIT);
  const rest = matches.slice(DOCUMENTED_LIMIT);
  const head = `${server}: ${matches.length} of ${tools.length} tools ${matches.length === 1 ? "matches" : "match"} ${JSON.stringify(query)}. ${call}`;
  const tail = rest.length > 0 ? `\n\nAlso matching, not shown: ${names(rest)}. Narrow the query to see them.` : "";
  return `${head}\n\n${documentation(server, documented)}${tail}`;
}

// Tool names are often singular where a query is plural ("list deployments", get_deployment).
function singular(term: string): string {
  return term.length > 3 && term.endsWith("s") && !term.endsWith("ss") ? term.slice(0, -1) : term;
}

function names(tools: readonly McpTool[]): string {
  const shown = tools.slice(0, NAMED_LIMIT).map(tool => tool.name).join(", ");
  return tools.length > NAMED_LIMIT ? `${shown}, and ${tools.length - NAMED_LIMIT} more` : shown;
}

function documentation(server: string, tools: readonly McpTool[]): string {
  const methods = tools.map(tool => {
    const schema = new SchemaRenderer(tool.inputSchema);
    const doc = toolDoc(tool);
    const args = schema.params();
    const output = tool.outputSchema ? ` & { structuredContent: ${new SchemaRenderer(tool.outputSchema).root()} }` : "";
    return `${doc ? `${jsDoc(doc, "  ")}\n` : ""}  ${key(tool.name)}(${args}): Promise<McpToolResult${output}>;`;
  });
  return `\`\`\`typescript\ninterface ${interfaceName(server)} {\n${methods.join("\n")}\n}\n\n${RESULT_DECLARATION}\n\`\`\``;
}

function toolDoc(tool: McpTool): string {
  const description = tool.description?.trim() ?? "";
  const title = tool.title?.trim();
  const lines = [title && title !== tool.name ? (description ? `${title}: ${description}` : title) : description];
  if (tool.annotations?.readOnlyHint) lines.push("Read-only.");
  else if (tool.annotations?.destructiveHint) lines.push("Destructive.");
  return lines.filter(Boolean).join("\n");
}

function interfaceName(server: string): string {
  return `${server.split(/[^A-Za-z0-9]+/).filter(Boolean).map(part => part[0]!.toUpperCase() + part.slice(1)).join("")}Tools`;
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

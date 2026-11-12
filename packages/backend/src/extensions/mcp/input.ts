/**
 * A server as callers give it, to add (`McpServerInputSchema`) or change (`McpServerUpdateSchema`), and its
 * check, `parseMcpServerInput`. The model checks it (`McpServers.create`, `McpServerModel.update`), so the
 * HTTP API and `reins.mcp` refuse the same input with the same message; they give the model what they got.
 */

import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { McpAuthKindSchema, McpRemoteTransportSchema, McpTransportKindSchema } from "./store.js";

/** Input the model refuses: the message says why, for the user or agent that gave it. */
export class InvalidMcpServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidMcpServerError";
  }
}

const nullableString = (maxLength: number, description: string) =>
  Type.Optional(Type.Union([Type.String({ maxLength }), Type.Null()], { description }));

const commonProperties = {
  name: Type.String({ maxLength: 100, description: "Lowercase letters, digits and hyphens, starting with a letter; at most 32; unique." }),
  instructions: Type.Optional(Type.String({
    maxLength: 4000,
    description: "Given to agents in their system prompt under the server's name: what it is for and how to use it.",
  })),
  enabled: Type.Optional(Type.Boolean()),
};

const remoteProperties = {
  url: Type.String({ maxLength: 2000, description: "Its MCP endpoint, http or https." }),
  transport: Type.Optional(Type.Union(McpRemoteTransportSchema.anyOf, {
    description: "\"http\" (streamable HTTP, the default) or \"sse\" (a legacy HTTP+SSE server, from before streamable HTTP).",
  })),
  authKind: Type.Optional(Type.Union(McpAuthKindSchema.anyOf, { description: "\"oauth\", \"header\" or \"none\" (the default)." })),
  headerName: nullableString(200, "Header auth: the header's name, e.g. Authorization or X-Api-Key."),
  headerValue: nullableString(8000, "Header auth: the header's value, stored encrypted and never returned."),
  oauthClientId: nullableString(500, "OAuth: a client registered with the server beforehand (Slack's); omit to register dynamically."),
  oauthClientSecret: nullableString(2000, "OAuth: that client's secret, stored encrypted and never returned."),
  oauthScope: nullableString(2000, "OAuth: the scope to ask for, when not the server's own."),
};

const stdioProperties = {
  transport: Type.Optional(Type.Literal("stdio", { description: "\"stdio\": the default when a command is given." })),
  command: Type.String({ maxLength: 1000, description: "The program to run, for each calling session, on its node (its PATH): npx, uvx, a path." }),
  args: Type.Optional(Type.Array(Type.String({ maxLength: 4000 }), { maxItems: 100, description: "The program's arguments." })),
  env: Type.Optional(Type.Record(Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]*$" }), Type.Union([Type.String({ maxLength: 16_000 }), Type.Null()]), {
    maxProperties: 100,
    additionalProperties: false,
    description: "Environment variables added to the node's, stored encrypted and never returned (only their names). " +
      "A change gives every variable the server keeps: one left out is removed, one given as null keeps its stored value.",
  })),
  cwd: nullableString(1000, "Where it starts: relative to the calling session's checkout, or absolute or ~/…; null or left out: the checkout."),
};

/** A remote server, as the HTTP API and scripts give it. Secrets are given in clear and stored encrypted. The lengths
 * bound what is stored and what reaches every prompt; `validMcpServerFields` checks the rest. */
export const McpRemoteInputSchema = Type.Object({ ...commonProperties, ...remoteProperties }, { additionalProperties: false, description: "A remote server, by its URL." });
/** A stdio server: the fields of an entry of the common `mcpServers` config shape, and a name. */
export const McpStdioInputSchema = Type.Object({ ...commonProperties, ...stdioProperties }, { additionalProperties: false, description: "A stdio server, by its command." });
/** A new server: remote (`url`) or stdio (`command`). */
export const McpServerInputSchema = Type.Union([McpRemoteInputSchema, McpStdioInputSchema]);
export type McpServerInput = Static<typeof McpServerInputSchema>;

/** A change: what is left out is kept; a secret given as null is removed. Its fields must be its kind's (the
 * server's, or the one `transport` changes it to), which the model checks (`checkMcpUpdateKind`). */
export const McpServerUpdateSchema = Type.Partial(Type.Object({
  ...commonProperties, ...remoteProperties, ...stdioProperties,
  transport: Type.Union(McpTransportKindSchema.anyOf, { description: "Changes its kind: \"http\" or \"sse\" (give url), or \"stdio\" (give command)." }),
}), { additionalProperties: false });
export type McpServerUpdate = Static<typeof McpServerUpdateSchema>;

const REMOTE_ONLY = Object.keys(remoteProperties).filter(key => key !== "transport");
const STDIO_ONLY = Object.keys(stdioProperties).filter(key => key !== "transport");

/** A new server's input: its kind's schema, picked by its keys (`command` or `transport: "stdio"` is stdio), checked
 * so that a wrong field is named; else `InvalidMcpServerError`. */
export function parseMcpServerCreation(value: unknown): McpServerInput {
  const stdio = typeof value === "object" && value !== null && ("command" in value || ("transport" in value && value.transport === "stdio"));
  return stdio ? parseMcpServerInput(McpStdioInputSchema, value) : parseMcpServerInput(McpRemoteInputSchema, value);
}

/** Refuses a change that gives fields of the other kind than `kind` (the server's, after the change). */
export function checkMcpUpdateKind(update: McpServerUpdate, kind: "remote" | "stdio"): void {
  const foreign = Object.keys(update).find(key => (kind === "stdio" ? REMOTE_ONLY : STDIO_ONLY).includes(key));
  if (foreign) {
    throw new InvalidMcpServerError(`${foreign} is a ${kind === "stdio" ? "remote" : "stdio"} server's field; this is a ${kind} server (give transport to change its kind)`);
  }
}

/** `value` as `schema` gives it; else `InvalidMcpServerError`, naming the first field that is wrong. */
export function parseMcpServerInput<T extends TSchema>(schema: T, value: unknown): Static<T> {
  if (Value.Check(schema, value)) return value;
  const first = Value.Errors(schema, value).First();
  throw new InvalidMcpServerError(`Invalid server: ${first ? `${first.path || "/"}: ${first.message}` : "does not match"}`);
}

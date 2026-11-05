/**
 * A server as callers give it, to add (`McpServerInputSchema`) or change (`McpServerUpdateSchema`), and its
 * check, `parseMcpServerInput`. The model checks it (`McpServers.create`, `McpServerModel.update`), so the
 * HTTP API and `reins.mcp` refuse the same input with the same message; they give the model what they got.
 */

import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { McpAuthKindSchema, McpTransportKindSchema } from "./store.js";

/** Input the model refuses: the message says why, for the user or agent that gave it. */
export class InvalidMcpServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidMcpServerError";
  }
}

const nullableString = (maxLength: number, description: string) =>
  Type.Optional(Type.Union([Type.String({ maxLength }), Type.Null()], { description }));

/** A new server, as the HTTP API and scripts give it: one schema, so their fields agree. Secrets are
 * given in clear and stored encrypted. The lengths bound what is stored and what reaches every prompt; `validMcpServerFields` checks the rest. */
export const McpServerInputSchema = Type.Object({
  name: Type.String({ maxLength: 100, description: "Lowercase letters, digits and hyphens, starting with a letter; at most 32; unique." }),
  instructions: Type.Optional(Type.String({
    maxLength: 4000,
    description: "Given to agents in their system prompt under the server's name: what it is for and how to use it.",
  })),
  url: Type.String({ maxLength: 2000, description: "Its MCP endpoint, http or https." }),
  transport: Type.Optional(Type.Union(McpTransportKindSchema.anyOf, {
    description: "\"http\" (streamable HTTP, the default) or \"sse\" (a legacy HTTP+SSE server, from before streamable HTTP).",
  })),
  authKind: McpAuthKindSchema,
  headerName: nullableString(200, "Header auth: the header's name, e.g. Authorization or X-Api-Key."),
  headerValue: nullableString(8000, "Header auth: the header's value, stored encrypted and never returned."),
  oauthClientId: nullableString(500, "OAuth: a client registered with the server beforehand (Slack's); omit to register dynamically."),
  oauthClientSecret: nullableString(2000, "OAuth: that client's secret, stored encrypted and never returned."),
  oauthScope: nullableString(2000, "OAuth: the scope to ask for, when not the server's own."),
  enabled: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });
export type McpServerInput = Static<typeof McpServerInputSchema>;

/** A change: what is left out is kept; a secret given as null is removed. */
export const McpServerUpdateSchema = Type.Partial(McpServerInputSchema, { additionalProperties: false });
export type McpServerUpdate = Static<typeof McpServerUpdateSchema>;

/** `value` as `schema` gives it; else `InvalidMcpServerError`, naming the first field that is wrong. */
export function parseMcpServerInput<T extends TSchema>(schema: T, value: unknown): Static<T> {
  if (Value.Check(schema, value)) return value;
  const first = Value.Errors(schema, value).First();
  throw new InvalidMcpServerError(`Invalid server: ${first ? `${first.path || "/"}: ${first.message}` : "does not match"}`);
}

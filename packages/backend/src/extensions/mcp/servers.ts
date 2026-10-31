/**
 * The user's remote MCP servers (`McpServers`, docs/dev/mcp-servers.md): listing them, finding one
 * (`McpServerNotFoundError`), adding one and completing a sign-in, which its callback's state names. One
 * server is `McpServerModel` (mcp-server.ts). What a browser sees of a server is its view (`McpServerView`),
 * whose secrets are only said to be set; the input schemas are here so the routes and scripts share them.
 */

import { Type, type Static } from "@sinclair/typebox";
import { McpAuthKindSchema, McpTransportKindSchema, type McpAuthKind, type McpStore, type McpTransportKind } from "./store.js";
import type { McpConnections, McpServerStatus } from "./connections.js";
import { finishMcpSignIn, hashSignInState } from "./oauth-provider.js";
import { InvalidMcpServerError, McpServerModel, validMcpServerFields, withUniqueMcpServerName } from "./server.js";

/** What browsers are told of a change (`reins.broadcast`). */
export type McpMessage =
  /** The server as it is now: created, changed, signed in or out, or its status changed. */
  | { type: "mcp_server_updated"; server: McpServerView }
  | { type: "mcp_server_removed"; serverId: number };

/** What the servers work with: their store, the app's connections to them, the browsers, and the path of
 * the OAuth callback page from the server's root. */
export interface McpContext {
  store: McpStore;
  connections: McpConnections;
  broadcast(message: McpMessage): void;
  callbackPath: string;
}

/** A sign-in's callback must come within this many seconds of its start. */
const SIGN_IN_TTL_SECONDS = 15 * 60;

export interface McpServerView {
  id: number;
  name: string;
  /** Given to agents in their system prompt. */
  instructions: string;
  url: string;
  transport: McpTransportKind;
  authKind: McpAuthKind;
  headerName: string | null;
  /** Whether the header has a value (it is never sent to the browser). */
  hasHeaderValue: boolean;
  /** A pre-registered OAuth client, else null (dynamic registration). */
  oauthClientId: string | null;
  hasClientSecret: boolean;
  /** The scope sign-ins ask for, else the server's own. */
  oauthScope: string | null;
  enabled: boolean;
  /** OAuth: it holds tokens. */
  signedIn: boolean;
  status: McpServerStatus;
  createdAt: string;
  updatedAt: string;
}

const nullableString = (maxLength: number, description: string) =>
  Type.Optional(Type.Union([Type.String({ maxLength }), Type.Null()], { description }));

/** A new server, as the HTTP API and scripts give it: one schema, so their fields agree. Secrets are
 * given in clear and stored encrypted. The lengths only bound a request; `validMcpServerFields` checks the rest. */
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

/** A sign-in started: where to send the user, and where their browser comes back with the code. */
export interface McpSignInStart { authorizationUrl: string; callbackUrl: string }

export class McpServerNotFoundError extends Error {
  constructor(server: number | string, known?: readonly string[]) {
    super(`MCP server not found: ${server}${known ? ` (the servers: ${known.length ? known.join(", ") : "none"})` : ""}`);
    this.name = "McpServerNotFoundError";
  }
}

/** A sign-in callback that completes nothing: unknown or expired state, refused or failed exchange. */
export class McpSignInError extends Error {
  constructor(message: string, readonly serverName: string | null = null) {
    super(message);
    this.name = "McpSignInError";
  }
}

/** The user's MCP servers: the context's connections reach them, and its `broadcast` tells browsers of changes. */
export class McpServers {
  constructor(readonly context: McpContext) {}

  private get store(): McpStore { return this.context.store; }

  /** Every server's view, in name order. */
  list(): McpServerView[] {
    return this.store.list().map(row => new McpServerModel(this, row).view());
  }

  /** Server `serverId`; throws `McpServerNotFoundError` for an unknown one. */
  get(serverId: number): McpServerModel {
    const row = this.store.get(serverId);
    if (!row) throw new McpServerNotFoundError(serverId);
    return new McpServerModel(this, row);
  }

  /** The server with this ID, or of this name (ignoring case). Not finding it names the servers there are, so
   * a wrong guess is its own discovery. */
  find(server: string | number): McpServerModel {
    const row = typeof server === "number" ? this.store.get(server) : this.store.getByName(server.trim().toLowerCase());
    if (!row) throw new McpServerNotFoundError(server, this.store.list().map(candidate => candidate.name));
    return new McpServerModel(this, row);
  }

  create(input: McpServerInput): McpServerView {
    const fields = validMcpServerFields({
      name: input.name, instructions: input.instructions ?? "", url: input.url, transport: input.transport ?? "http", authKind: input.authKind,
      headerName: input.headerName ?? null, oauthClientId: input.oauthClientId ?? null, oauthScope: input.oauthScope ?? null,
      enabled: input.enabled ?? true,
    });
    if (fields.authKind === "header" && !input.headerValue) throw new InvalidMcpServerError("Header authentication needs a value");
    const row = withUniqueMcpServerName(fields.name, () => this.store.transaction(() => {
      const created = this.store.insert(fields);
      if (fields.authKind === "header") this.store.setSecret(created.id, "header_value", input.headerValue ?? null);
      if (fields.oauthClientId && input.oauthClientSecret) this.store.setSecret(created.id, "client_secret", input.oauthClientSecret);
      return created;
    }));
    return this.get(row.id).publish();
  }

  /** Completes the sign-in the callback's query names (`state`, which says whose it is) with its `code`, or
   * records its refusal (`error`): the server signed in, its connection replaced. Throws `McpSignInError`. */
  async finishSignIn(query: { state?: string | null; code?: string | null; error?: string | null; errorDescription?: string | null }): Promise<McpServerView> {
    const pending = query.state ? this.store.findSignIn(hashSignInState(query.state)) : null;
    if (!pending) throw new McpSignInError("This sign-in is unknown or was replaced by a newer one. Start it again from Reins' settings.");
    const server = this.get(pending.serverId).row;
    if (pending.ageSeconds > SIGN_IN_TTL_SECONDS) {
      this.store.endSignIn(server.id);
      throw new McpSignInError("This sign-in expired. Start it again from Reins' settings.", server.name);
    }
    if (query.error || !query.code) {
      this.store.endSignIn(server.id);
      const reason = query.errorDescription ?? query.error ?? "no authorization code";
      throw new McpSignInError(`Signing in to ${server.name} was refused: ${reason}`, server.name);
    }
    try {
      await finishMcpSignIn(this.store, server, pending, query.code);
    } catch (error) {
      throw new McpSignInError(`Signing in to ${server.name} failed: ${error instanceof Error ? error.message : String(error)}`, server.name);
    } finally {
      this.store.endSignIn(server.id);
    }
    await this.context.connections.disconnect(server.id);
    // Connect now, so a failure shows at once rather than at the first use.
    void this.context.connections.test(server.id).catch(() => undefined);
    return this.get(server.id).publish();
  }
}

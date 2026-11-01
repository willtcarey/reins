/**
 * The user's remote MCP servers (`McpServers`, docs/dev/mcp-servers.md): listing them, finding one
 * (`McpServerNotFoundError`), adding one and completing a sign-in, which its callback's state names. One
 * server is `McpServerModel` (server.ts). What a browser sees of a server is its view (`McpServerView`),
 * whose secrets are only said to be set. Its input and the check of it are in input.ts.
 */

import type { McpAuthKind, McpStore, McpTransportKind } from "./store.js";
import type { McpConnections, McpServerStatus } from "./connections.js";
import { finishMcpSignIn, hashSignInState } from "./oauth-provider.js";
import { McpServerModel, validMcpServerFields, withUniqueMcpServerName } from "./server.js";
import { InvalidMcpServerError, McpServerInputSchema, parseMcpServerInput } from "./input.js";

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
  list(): Promise<McpServerView[]> {
    return Promise.all(this.store.list().map(row => new McpServerModel(this, row).view()));
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

  /** A secret that cannot be stored undoes the server's creation. */
  async create(server: unknown): Promise<McpServerView> {
    const input = parseMcpServerInput(McpServerInputSchema, server);
    const fields = validMcpServerFields({
      name: input.name, instructions: input.instructions ?? "", url: input.url, transport: input.transport ?? "http", authKind: input.authKind,
      headerName: input.headerName ?? null, oauthClientId: input.oauthClientId ?? null, oauthScope: input.oauthScope ?? null,
      enabled: input.enabled ?? true,
    });
    if (fields.authKind === "header" && !input.headerValue) throw new InvalidMcpServerError("Header authentication needs a value");
    const row = withUniqueMcpServerName(fields.name, () => this.store.insert(fields));
    try {
      if (fields.authKind === "header") await this.store.setSecret(row.id, "header_value", input.headerValue ?? null);
      if (fields.oauthClientId && input.oauthClientSecret) await this.store.setSecret(row.id, "client_secret", input.oauthClientSecret);
    } catch (error) {
      await this.store.delete(row.id);
      throw error;
    }
    return this.get(row.id).publish();
  }

  /** Completes the sign-in the callback's query names (`state`, which says whose it is) with its `code`, or
   * records its refusal (`error`): the server signed in, its connection replaced. Throws `McpSignInError`. */
  async finishSignIn(query: { state?: string | null; code?: string | null; error?: string | null; errorDescription?: string | null }): Promise<McpServerView> {
    const pending = query.state ? this.store.findSignIn(hashSignInState(query.state)) : null;
    if (!pending) throw new McpSignInError("This sign-in is unknown or was replaced by a newer one. Start it again from Reins' settings.");
    const server = this.get(pending.serverId).row;
    if (pending.ageSeconds > SIGN_IN_TTL_SECONDS) {
      await this.store.endSignIn(server.id);
      throw new McpSignInError("This sign-in expired. Start it again from Reins' settings.", server.name);
    }
    if (query.error || !query.code) {
      await this.store.endSignIn(server.id);
      const reason = query.errorDescription ?? query.error ?? "no authorization code";
      throw new McpSignInError(`Signing in to ${server.name} was refused: ${reason}`, server.name);
    }
    try {
      await finishMcpSignIn(this.store, server, pending, query.code);
    } catch (error) {
      throw new McpSignInError(`Signing in to ${server.name} failed: ${error instanceof Error ? error.message : String(error)}`, server.name);
    } finally {
      await this.store.endSignIn(server.id);
    }
    await this.context.connections.disconnect(server.id);
    // Connect now, so a failure shows at once rather than at the first use.
    void this.context.connections.test(server.id).catch(() => undefined);
    return this.get(server.id).publish();
  }
}

/**
 * The user's remote MCP servers (`McpServers`, docs/dev/mcp-servers.md): listing them, finding one
 * (`McpServerNotFoundError`), adding one and completing a sign-in, which its callback's state names. One
 * server is `McpServerModel` (server.ts). What a browser sees of a server is its view (`McpServerView`),
 * whose secrets are only said to be set. Its input and the check of it are in input.ts.
 */

import type { McpAuthKind, McpRemoteTransport, McpSecretKind, McpServerFields, McpStore } from "./store.js";
import type { McpConnections, McpServerStatus } from "./connections.js";
import type { McpStdio } from "./stdio.js";
import { finishMcpSignIn, hashSignInState } from "./oauth-provider.js";
import { McpServerModel, mergedEnv, validRemoteFields, validStdioFields, withUniqueMcpServerName } from "./server.js";
import { InvalidMcpServerError, parseMcpServerCreation } from "./input.js";

/** What browsers are told of a change (`reins.broadcast`). */
export type McpMessage =
  /** The server as it is now: created, changed, signed in or out, or its status changed. */
  | { type: "mcp_server_updated"; server: McpServerView }
  | { type: "mcp_server_removed"; serverId: number };

/** What the servers work with: their store, the app's connections to them, the browsers, the path of
 * the OAuth callback page from the server's root, and stdio servers' processes. */
export interface McpContext {
  store: McpStore;
  connections: McpConnections;
  broadcast(message: McpMessage): void;
  callbackPath: string;
  stdio: McpStdio;
}

/** A sign-in's callback must come within this many seconds of its start. */
const SIGN_IN_TTL_SECONDS = 15 * 60;

interface McpCommonView {
  id: number;
  name: string;
  /** Given to agents in their system prompt. */
  instructions: string;
  enabled: boolean;
  status: McpServerStatus;
  createdAt: string;
  updatedAt: string;
}

/** A remote server, reached at its URL. Its secrets are only said to be set. */
export interface McpRemoteServerView extends McpCommonView {
  transport: McpRemoteTransport;
  url: string;
  authKind: McpAuthKind;
  headerName: string | null;
  /** Whether the header has a value (it is never sent to the browser). */
  hasHeaderValue: boolean;
  /** A pre-registered OAuth client, else null (dynamic registration). */
  oauthClientId: string | null;
  hasClientSecret: boolean;
  /** The scope sign-ins ask for, else the server's own. */
  oauthScope: string | null;
  /** OAuth: it holds tokens. */
  signedIn: boolean;
}

/** A stdio server: a program run for each calling session, in its checkout. */
export interface McpStdioServerView extends McpCommonView {
  transport: "stdio";
  command: string;
  args: string[];
  /** Where it starts: null, the session's checkout; relative, inside it. */
  cwd: string | null;
  /** The names of its environment variables (their values are never sent to the browser). */
  envNames: string[];
}

/** A server as browsers and scripts see it: remote or stdio, told apart by `transport`. */
export type McpServerView = McpRemoteServerView | McpStdioServerView;

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
    const input = parseMcpServerCreation(server);
    const common = { name: input.name, instructions: input.instructions ?? "", enabled: input.enabled ?? true };
    const secrets: Array<[McpSecretKind, string]> = [];
    let fields: McpServerFields;
    if ("command" in input) {
      fields = validStdioFields({ ...common, transport: "stdio", command: input.command, args: input.args ?? [], cwd: input.cwd ?? null });
      const env = input.env ? mergedEnv(input.env, {}) : {};
      if (Object.keys(env).length) secrets.push(["env", JSON.stringify(env)]);
    } else {
      const remote = validRemoteFields({
        ...common, transport: input.transport ?? "http", url: input.url, authKind: input.authKind ?? "none",
        headerName: input.headerName ?? null, oauthClientId: input.oauthClientId ?? null, oauthScope: input.oauthScope ?? null,
      });
      if (remote.authKind === "header" && !input.headerValue) throw new InvalidMcpServerError("Header authentication needs a value");
      if (remote.authKind === "header" && input.headerValue) secrets.push(["header_value", input.headerValue]);
      if (remote.oauthClientId && input.oauthClientSecret) secrets.push(["client_secret", input.oauthClientSecret]);
      fields = remote;
    }
    const row = withUniqueMcpServerName(fields.name, () => this.store.insert(fields));
    try {
      for (const [kind, value] of secrets) await this.store.setSecret(row.id, kind, value);
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
    // A change to stdio ends a sign-in in progress, so only a remote server has one.
    if (server.transport === "stdio") throw new McpSignInError("This sign-in is unknown or was replaced by a newer one. Start it again from Reins' settings.");
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

/**
 * The user's remote MCP servers (docs/dev/mcp-servers.md): their configuration and credentials, signing
 * in and out, and their tools through the app's connections (`AppState.mcp`). What a browser sees of a
 * server is its view, whose secrets are only said to be set.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { AppState } from "../state.js";
import { createBroadcast, type Broadcast } from "./broadcast.js";
import {
  deleteMcpSecrets, deleteMcpServer, endMcpSignIn, findMcpSignIn, getMcpServer, getMcpServerByName, insertMcpServer, latestMcpRedirectUrl, listMcpServers,
  McpAuthKindSchema, mcpSecretKinds, setMcpSecret, updateMcpServer,
  type McpAuthKind, type McpSecretKind, type McpServerFields, type McpServerRow, type McpTransportKind,
} from "../mcp-server-store.js";
import {
  McpServerNotFoundError, type CallOptions, type McpServerStatus, type McpTool,
} from "../mcp/connections.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { finishMcpSignIn, hashSignInState, startMcpSignIn } from "../mcp/oauth-provider.js";
import { API } from "../api-paths.js";

/** A server's name is the identifier its tools will be namespaced under. */
export const MCP_SERVER_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
/** A sign-in's callback must come within this many seconds of its start. */
const SIGN_IN_TTL_SECONDS = 15 * 60;
const OAUTH_SECRETS: readonly McpSecretKind[] = ["client_information", "tokens", "code_verifier", "discovery"];

export interface McpServerView {
  id: number;
  name: string;
  description: string;
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
  /** How many tools it listed last on this app, null before it listed any. */
  toolCount: number | null;
  createdAt: string;
  updatedAt: string;
}

const nullableString = (maxLength: number, description: string) =>
  Type.Optional(Type.Union([Type.String({ maxLength }), Type.Null()], { description }));

/** A new server, as the HTTP API and scripts give it: one schema, so their fields agree. Secrets are
 * given in clear and stored encrypted. The lengths only bound a request; `validFields` checks the rest. */
export const McpServerInputSchema = Type.Object({
  name: Type.String({ maxLength: 100, description: "Lowercase letters, digits and hyphens, starting with a letter; at most 32; unique." }),
  description: Type.Optional(Type.String({ maxLength: 2000 })),
  url: Type.String({ maxLength: 2000, description: "Its MCP endpoint, http or https." }),
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

export class InvalidMcpServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidMcpServerError";
  }
}

export class McpServerNameTakenError extends Error {
  constructor(name: string) {
    super(`An MCP server is already named ${name}`);
    this.name = "McpServerNameTakenError";
  }
}

/** The server is not set up for what was asked (signing in to a server without OAuth). */
export class McpServerAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpServerAuthError";
  }
}

/** A sign-in callback that completes nothing: unknown or expired state, refused or failed exchange. */
export class McpSignInError extends Error {
  constructor(message: string, readonly serverName: string | null = null) {
    super(message);
    this.name = "McpSignInError";
  }
}

function trimmedOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function validFields(fields: McpServerFields): McpServerFields {
  const name = fields.name.trim();
  if (!MCP_SERVER_NAME_PATTERN.test(name)) {
    throw new InvalidMcpServerError("Name must start with a lowercase letter and have only lowercase letters, digits and hyphens (at most 32)");
  }
  const url = fields.url.trim();
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new InvalidMcpServerError(`Not a URL: ${url}`); }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new InvalidMcpServerError("The URL must be http or https");
  const headerName = fields.authKind === "header" ? trimmedOrNull(fields.headerName) : null;
  if (fields.authKind === "header" && (!headerName || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(headerName))) {
    throw new InvalidMcpServerError("Header authentication needs a valid header name");
  }
  const oauth = fields.authKind === "oauth";
  return {
    ...fields,
    name,
    url,
    description: fields.description.trim(),
    headerName,
    oauthClientId: oauth ? trimmedOrNull(fields.oauthClientId) : null,
    oauthScope: oauth ? trimmedOrNull(fields.oauthScope) : null,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed: mcp_servers\.name/.test(error.message);
}

export class McpServers {
  constructor(private readonly state: AppState, private readonly broadcast: Broadcast) {}

  /** In name order. */
  list(): McpServerView[] {
    return listMcpServers().map(row => this.viewOf(row));
  }

  get(serverId: number): McpServerView {
    return this.viewOf(this.row(serverId));
  }

  /** The ID of the server named `server`, or with that ID. Throws `McpServerNotFoundError` naming the servers
   * there are. */
  resolve(server: string | number): number {
    const row = typeof server === "number" ? getMcpServer(server) : getMcpServerByName(server.trim().toLowerCase());
    if (!row) throw new McpServerNotFoundError(server, listMcpServers().map(candidate => candidate.name));
    return row.id;
  }

  create(input: McpServerInput): McpServerView {
    const fields = validFields({
      name: input.name, description: input.description ?? "", url: input.url, transport: "http", authKind: input.authKind,
      headerName: input.headerName ?? null, oauthClientId: input.oauthClientId ?? null, oauthScope: input.oauthScope ?? null,
      enabled: input.enabled ?? true,
    });
    if (fields.authKind === "header" && !input.headerValue) throw new InvalidMcpServerError("Header authentication needs a value");
    let row: McpServerRow;
    try {
      row = this.state.process.db.transaction(() => {
        const created = insertMcpServer(fields);
        if (fields.authKind === "header") setMcpSecret(created.id, "header_value", input.headerValue ?? null);
        if (fields.oauthClientId && input.oauthClientSecret) setMcpSecret(created.id, "client_secret", input.oauthClientSecret);
        return created;
      })();
    } catch (error) {
      if (isUniqueViolation(error)) throw new McpServerNameTakenError(fields.name);
      throw error;
    }
    return this.publish(row.id);
  }

  /** A change to where or how it connects closes its connection; one to where it is or which OAuth client
   * signs in also signs it out (its tokens and registration belong to the old ones). */
  async update(serverId: number, update: McpServerUpdate): Promise<McpServerView> {
    const before = this.row(serverId);
    const fields = validFields({
      name: update.name ?? before.name,
      description: update.description ?? before.description,
      url: update.url ?? before.url,
      transport: before.transport,
      authKind: update.authKind ?? before.authKind,
      headerName: update.headerName !== undefined ? update.headerName : before.headerName,
      oauthClientId: update.oauthClientId !== undefined ? update.oauthClientId : before.oauthClientId,
      oauthScope: update.oauthScope !== undefined ? update.oauthScope : before.oauthScope,
      enabled: update.enabled ?? before.enabled,
    });
    const secrets = mcpSecretKinds(serverId);
    if (fields.authKind === "header" && update.headerValue === null) throw new InvalidMcpServerError("Header authentication needs a value");
    if (fields.authKind === "header" && !update.headerValue && !(before.authKind === "header" && secrets.has("header_value"))) {
      throw new InvalidMcpServerError("Header authentication needs a value");
    }
    const reauthorize = fields.url !== before.url || fields.authKind !== before.authKind || fields.oauthClientId !== before.oauthClientId;
    try {
      this.state.process.db.transaction(() => {
        updateMcpServer(serverId, fields);
        if (fields.authKind !== "header") deleteMcpSecrets(serverId, ["header_value"]);
        else if (update.headerValue) setMcpSecret(serverId, "header_value", update.headerValue);
        if (!fields.oauthClientId || update.oauthClientSecret === null) deleteMcpSecrets(serverId, ["client_secret"]);
        else if (update.oauthClientSecret) setMcpSecret(serverId, "client_secret", update.oauthClientSecret);
        if (reauthorize) {
          deleteMcpSecrets(serverId, OAUTH_SECRETS);
          endMcpSignIn(serverId);
        }
      })();
    } catch (error) {
      if (isUniqueViolation(error)) throw new McpServerNameTakenError(fields.name);
      throw error;
    }
    const changed = reauthorize || fields.enabled !== before.enabled || fields.headerName !== before.headerName
      || update.headerValue !== undefined || update.oauthClientSecret !== undefined || fields.oauthScope !== before.oauthScope;
    if (changed) await this.state.mcp.disconnect(serverId);
    return this.publish(serverId);
  }

  /** Removes it with its credentials, closing its connection. */
  async remove(serverId: number): Promise<void> {
    this.row(serverId);
    await this.state.mcp.disconnect(serverId);
    deleteMcpServer(serverId);
    this.broadcast({ type: "mcp_server_removed", serverId });
  }

  /** Connects to it afresh, listing its tools: its view after the attempt. */
  async test(serverId: number, signal?: AbortSignal): Promise<McpServerView> {
    this.row(serverId);
    await this.state.mcp.test(serverId, signal);
    return this.get(serverId);
  }

  /** Starts a sign-in whose callback is `callbackUrl` (this server's `/oauth/mcp/callback` as the user's
   * browser reaches it; by default the one of the latest completed sign-in, else `http://localhost:<port>`): the URL to
   * send the user to. A sign-in started earlier stops working. */
  async startSignIn(serverId: number, callbackUrl = this.defaultCallbackUrl(serverId)): Promise<McpSignInStart> {
    const server = this.row(serverId);
    if (server.authKind !== "oauth") throw new McpServerAuthError(`MCP server ${server.name} does not use OAuth`);
    const url = await startMcpSignIn(server, callbackUrl);
    return { authorizationUrl: url.href, callbackUrl };
  }

  /** The origin of the latest completed sign-in: the callback's path is this code's. */
  private defaultCallbackUrl(serverId: number): string {
    const latest = latestMcpRedirectUrl(serverId);
    return `${latest ? new URL(latest).origin : `http://localhost:${process.env.REINS_PORT || "3100"}`}${API.mcpOAuthCallback}`;
  }

  /** Completes the sign-in the callback's query names (`state`) with its `code`, or records its refusal
   * (`error`): the server signed in, its connection replaced. */
  async finishSignIn(query: { state?: string | null; code?: string | null; error?: string | null; errorDescription?: string | null }): Promise<McpServerView> {
    const pending = query.state ? findMcpSignIn(hashSignInState(query.state)) : null;
    if (!pending) throw new McpSignInError("This sign-in is unknown or was replaced by a newer one. Start it again from Reins' settings.");
    const server = this.row(pending.serverId);
    if (pending.ageSeconds > SIGN_IN_TTL_SECONDS) {
      endMcpSignIn(server.id);
      throw new McpSignInError("This sign-in expired. Start it again from Reins' settings.", server.name);
    }
    if (query.error || !query.code) {
      endMcpSignIn(server.id);
      const reason = query.errorDescription ?? query.error ?? "no authorization code";
      throw new McpSignInError(`Signing in to ${server.name} was refused: ${reason}`, server.name);
    }
    try {
      await finishMcpSignIn(server, pending, query.code);
    } catch (error) {
      throw new McpSignInError(`Signing in to ${server.name} failed: ${error instanceof Error ? error.message : String(error)}`, server.name);
    } finally {
      endMcpSignIn(server.id);
    }
    await this.state.mcp.disconnect(server.id);
    // Connect now, so the user sees it connected (or why not) and its tools are listed.
    void this.state.mcp.test(server.id).catch(() => undefined);
    return this.publish(server.id);
  }

  /** Forgets its tokens (its client registration stays, for the next sign-in) and closes its connection. */
  async signOut(serverId: number): Promise<McpServerView> {
    const server = this.row(serverId);
    if (server.authKind !== "oauth") throw new McpServerAuthError(`MCP server ${server.name} does not use OAuth`);
    deleteMcpSecrets(serverId, ["tokens"]);
    endMcpSignIn(serverId);
    await this.state.mcp.disconnect(serverId);
    return this.publish(serverId);
  }

  /** Its tools (name, description, input schema), connecting if needed. Throws
   * `McpServerUnavailableError` when it is disabled, needs sign-in or cannot be reached. */
  listTools(serverId: number, options: { signal?: AbortSignal } = {}): Promise<McpTool[]> {
    this.row(serverId);
    return this.state.mcp.listTools(serverId, options);
  }

  /** Calls one of its tools (`McpConnections.callTool`). */
  callTool(serverId: number, name: string, args: Record<string, unknown>, options: CallOptions = {}): Promise<CallToolResult> {
    this.row(serverId);
    return this.state.mcp.callTool(serverId, name, args, options);
  }

  /** Tells browsers the server as it is now (`mcp_server_updated`); its view. */
  publish(serverId: number): McpServerView {
    const server = this.get(serverId);
    this.broadcast({ type: "mcp_server_updated", server });
    return server;
  }

  private row(serverId: number): McpServerRow {
    const row = getMcpServer(serverId);
    if (!row) throw new McpServerNotFoundError(serverId);
    return row;
  }

  private viewOf(row: McpServerRow): McpServerView {
    const secrets = mcpSecretKinds(row.id);
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      url: row.url,
      transport: row.transport,
      authKind: row.authKind,
      headerName: row.headerName,
      hasHeaderValue: secrets.has("header_value"),
      oauthClientId: row.oauthClientId,
      hasClientSecret: secrets.has("client_secret"),
      oauthScope: row.oauthScope,
      enabled: row.enabled,
      signedIn: secrets.has("tokens"),
      status: this.state.mcp.status(row.id),
      toolCount: this.state.mcp.toolCount(row.id),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

/** Tells browsers the server as it is now, unless it was removed meanwhile: what the app's connections
 * call on a change of status or tools. */
export function publishMcpServer(state: AppState, serverId: number): void {
  if (getMcpServer(serverId)) new McpServers(state, createBroadcast(state.process)).publish(serverId);
}

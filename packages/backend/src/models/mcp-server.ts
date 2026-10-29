/**
 * One remote MCP server (`McpServerModel`, docs/dev/mcp-servers.md): its view, changing and removing it,
 * signing in and out, and its tools through the app's connections, with the errors it throws. The
 * collection is `McpServers` (mcp-servers.ts).
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServers, McpServerUpdate, McpServerView, McpSignInStart } from "./mcp-servers.js";
import {
  deleteMcpSecrets, deleteMcpServer, endMcpSignIn, latestMcpRedirectUrl, mcpSecretKinds, setMcpSecret, updateMcpServer,
  type McpSecretKind, type McpServerFields, type McpServerRow,
} from "../mcp-server-store.js";
import type { CallOptions, McpTool } from "../mcp/connections.js";
import { startMcpSignIn } from "../mcp/oauth-provider.js";
import { API } from "../api-paths.js";

/** A server's name is the identifier its tools will be namespaced under. */
export const MCP_SERVER_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const OAUTH_SECRETS: readonly McpSecretKind[] = ["client_information", "tokens", "code_verifier", "discovery"];

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

function trimmedOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** The fields as stored: trimmed, and those of another auth kind cleared. Throws `InvalidMcpServerError`. */
export function validMcpServerFields(fields: McpServerFields): McpServerFields {
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

/** `write`, with the name's uniqueness reported as `McpServerNameTakenError`. */
export function withUniqueMcpServerName<T>(name: string, write: () => T): T {
  try {
    return write();
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed: mcp_servers\.name/.test(error.message)) throw new McpServerNameTakenError(name);
    throw error;
  }
}

/** One server, as its row was when it was read (`McpServers.get`, `find`). What changes it returns its view
 * read afresh. */
export class McpServerModel {
  constructor(private readonly servers: McpServers, readonly row: McpServerRow) {}

  get id(): number { return this.row.id; }

  get name(): string { return this.row.name; }

  view(): McpServerView {
    const { row } = this;
    const secrets = mcpSecretKinds(row.id);
    const connections = this.servers.state.mcp;
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
      status: connections.status(row, secrets.has("tokens")),
      toolCount: connections.toolCount(row.id),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /** Tells browsers the server as this model read it (`mcp_server_updated`); its view. */
  publish(): McpServerView {
    const server = this.view();
    this.servers.broadcast({ type: "mcp_server_updated", server });
    return server;
  }

  /** A change to where or how it connects closes its connection; one to where it is or which OAuth client
   * signs in also signs it out (its tokens and registration belong to the old ones). */
  async update(update: McpServerUpdate): Promise<McpServerView> {
    const before = this.row;
    const fields = validMcpServerFields({
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
    const secrets = mcpSecretKinds(this.id);
    if (fields.authKind === "header" && update.headerValue === null) throw new InvalidMcpServerError("Header authentication needs a value");
    if (fields.authKind === "header" && !update.headerValue && !(before.authKind === "header" && secrets.has("header_value"))) {
      throw new InvalidMcpServerError("Header authentication needs a value");
    }
    const reauthorize = fields.url !== before.url || fields.authKind !== before.authKind || fields.oauthClientId !== before.oauthClientId;
    withUniqueMcpServerName(fields.name, () => this.servers.state.process.db.transaction(() => {
      updateMcpServer(this.id, fields);
      if (fields.authKind !== "header") deleteMcpSecrets(this.id, ["header_value"]);
      else if (update.headerValue) setMcpSecret(this.id, "header_value", update.headerValue);
      if (!fields.oauthClientId || update.oauthClientSecret === null) deleteMcpSecrets(this.id, ["client_secret"]);
      else if (update.oauthClientSecret) setMcpSecret(this.id, "client_secret", update.oauthClientSecret);
      if (reauthorize) {
        deleteMcpSecrets(this.id, OAUTH_SECRETS);
        endMcpSignIn(this.id);
      }
    })());
    const changed = reauthorize || fields.enabled !== before.enabled || fields.headerName !== before.headerName
      || update.headerValue !== undefined || update.oauthClientSecret !== undefined || fields.oauthScope !== before.oauthScope;
    if (changed) await this.servers.state.mcp.disconnect(this.id);
    return this.reread().publish();
  }

  /** Removes it with its credentials, closing its connection. */
  async remove(): Promise<void> {
    await this.servers.state.mcp.disconnect(this.id);
    deleteMcpServer(this.id);
    this.servers.broadcast({ type: "mcp_server_removed", serverId: this.id });
  }

  /** Connects to it afresh, listing its tools: its view after the attempt. */
  async test(signal?: AbortSignal): Promise<McpServerView> {
    await this.servers.state.mcp.test(this.id, signal);
    return this.reread().view();
  }

  /** Starts a sign-in whose callback is `callbackUrl` (this server's `/oauth/mcp/callback` as the user's
   * browser reaches it; by default the one of the latest completed sign-in, else `http://localhost:<port>`): the URL to
   * send the user to. A sign-in started earlier stops working. The sign-in completes in `McpServers.finishSignIn`. */
  async startSignIn(callbackUrl = this.defaultCallbackUrl()): Promise<McpSignInStart> {
    this.assertOAuth();
    const url = await startMcpSignIn(this.row, callbackUrl);
    return { authorizationUrl: url.href, callbackUrl };
  }

  /** The origin of the latest completed sign-in: the callback's path is this code's. */
  private defaultCallbackUrl(): string {
    const latest = latestMcpRedirectUrl(this.id);
    return `${latest ? new URL(latest).origin : `http://localhost:${process.env.REINS_PORT || "3100"}`}${API.mcpOAuthCallback}`;
  }

  /** Forgets its tokens (its client registration stays, for the next sign-in) and closes its connection. */
  async signOut(): Promise<McpServerView> {
    this.assertOAuth();
    deleteMcpSecrets(this.id, ["tokens"]);
    endMcpSignIn(this.id);
    await this.servers.state.mcp.disconnect(this.id);
    return this.reread().publish();
  }

  /** Its tools (name, description, input schema), connecting if needed. Throws
   * `McpServerUnavailableError` when it is disabled, needs sign-in or cannot be reached. */
  listTools(options: { signal?: AbortSignal } = {}): Promise<McpTool[]> {
    return this.servers.state.mcp.listTools(this.id, options);
  }

  /** Calls one of its tools (`McpConnections.callTool`). */
  callTool(name: string, args: Record<string, unknown>, options: CallOptions = {}): Promise<CallToolResult> {
    return this.servers.state.mcp.callTool(this.id, name, args, options);
  }

  private assertOAuth(): void {
    if (this.row.authKind !== "oauth") throw new McpServerAuthError(`MCP server ${this.name} does not use OAuth`);
  }

  /** The server as it is now. */
  private reread(): McpServerModel {
    return this.servers.get(this.id);
  }
}

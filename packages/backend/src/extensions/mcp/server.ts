/**
 * One MCP server, remote or stdio (`McpServerModel`, docs/dev/mcp-servers.md): its view, changing and removing it,
 * signing in and out, and its tools through the app's connections, with the errors it throws. The
 * collection is `McpServers` (servers.ts).
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpContext, McpServers, McpServerView, McpSignInStart } from "./servers.js";
import { checkMcpUpdateKind, InvalidMcpServerError, MCP_SERVER_NAME_PATTERN, McpServerUpdateSchema, parseMcpServerInput, type McpServerUpdate } from "./input.js";
import type { McpRemoteFields, McpRemoteRow, McpRemoteTransport, McpSecretKind, McpServerFields, McpServerRow, McpStdioFields, McpStore } from "./store.js";
import type { CallOptions, McpTool, Placement } from "./connections.js";
import { startMcpSignIn, mcpSignedIn } from "./oauth-provider.js";

const MCP_REMOTE_TRANSPORTS: readonly McpRemoteTransport[] = ["http", "sse"];
const OAUTH_SECRETS: readonly McpSecretKind[] = ["client_information", "tokens", "code_verifier", "discovery"];

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
  return fields.transport === "stdio" ? validStdioFields(fields) : validRemoteFields(fields);
}

function validCommonFields(fields: McpServerFields) {
  const name = fields.name.trim();
  if (!MCP_SERVER_NAME_PATTERN.test(name)) {
    throw new InvalidMcpServerError("Name must start with a lowercase letter and have only lowercase letters, digits and hyphens (at most 32)");
  }
  return { name, instructions: fields.instructions.trim(), enabled: fields.enabled };
}

export function validStdioFields(fields: McpStdioFields): McpStdioFields {
  const command = fields.command.trim();
  if (!command) throw new InvalidMcpServerError("A stdio server needs a command");
  return { ...validCommonFields(fields), transport: "stdio", command, args: fields.args, cwd: trimmedOrNull(fields.cwd) };
}

export function validRemoteFields(fields: McpRemoteFields): McpRemoteFields {
  const common = validCommonFields(fields);
  if (!MCP_REMOTE_TRANSPORTS.includes(fields.transport)) throw new InvalidMcpServerError(`Unknown transport: ${String(fields.transport)} (http, sse or stdio)`);
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
    ...common,
    transport: fields.transport,
    url,
    authKind: fields.authKind,
    headerName,
    oauthClientId: oauth ? trimmedOrNull(fields.oauthClientId) : null,
    oauthScope: oauth ? trimmedOrNull(fields.oauthScope) : null,
  };
}

/** The fields a change gives the server: its own, changed. A change of kind (`transport`) starts from the new kind's
 * defaults, so its required fields (`url`, `command`) must be given. */
function changedFields(before: McpServerRow, update: McpServerUpdate): McpServerFields {
  const common = { name: update.name ?? before.name, instructions: update.instructions ?? before.instructions, enabled: update.enabled ?? before.enabled };
  const transport = update.transport ?? before.transport;
  checkMcpUpdateKind(update, transport === "stdio" ? "stdio" : "remote");
  if (transport === "stdio") {
    const was = before.transport === "stdio" ? before : null;
    return {
      ...common, transport,
      command: update.command ?? was?.command ?? "",
      args: update.args ?? was?.args ?? [],
      cwd: update.cwd !== undefined ? update.cwd : was?.cwd ?? null,
    };
  }
  const was = before.transport === "stdio" ? null : before;
  return {
    ...common, transport,
    url: update.url ?? was?.url ?? "",
    authKind: update.authKind ?? was?.authKind ?? "none",
    headerName: update.headerName !== undefined ? update.headerName : was?.headerName ?? null,
    oauthClientId: update.oauthClientId !== undefined ? update.oauthClientId : was?.oauthClientId ?? null,
    oauthScope: update.oauthScope !== undefined ? update.oauthScope : was?.oauthScope ?? null,
  };
}

/** The environment a change gives: every name it has, a null value keeping the one stored. */
export function mergedEnv(given: Record<string, string | null>, stored: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(given)) {
    const kept = value ?? stored[name];
    if (kept === undefined) throw new InvalidMcpServerError(`env ${name} has no value`);
    env[name] = kept;
  }
  return env;
}

function sameEnv(a: Record<string, string>, b: Record<string, string>): boolean {
  const names = Object.keys(a);
  return names.length === Object.keys(b).length && names.every(name => a[name] === b[name]);
}

/** `write`, with the name's uniqueness reported as `McpServerNameTakenError`. */
export function withUniqueMcpServerName<T>(name: string, write: () => T): T {
  try {
    return write();
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed: (mcp_servers\.name|index .mcp_servers_project_name.)/.test(error.message)) throw new McpServerNameTakenError(name);
    throw error;
  }
}

/** One server, as its row was when it was read (`McpServers.get`, `find`). What changes it returns its view
 * read afresh. */
export class McpServerModel {
  constructor(private readonly servers: McpServers, readonly row: McpServerRow) {}

  private get context(): McpContext { return this.servers.context; }
  private get store(): McpStore { return this.servers.context.store; }

  get id(): number { return this.row.id; }

  get name(): string { return this.row.name; }

  async view(): Promise<McpServerView> {
    const { row } = this;
    const common = { id: row.id, name: row.name, instructions: row.instructions, enabled: row.enabled, createdAt: row.createdAt, updatedAt: row.updatedAt };
    if (row.transport === "stdio") {
      return {
        ...common, transport: row.transport, command: row.command, args: row.args, cwd: row.cwd,
        envNames: Object.keys(await this.env()).toSorted(),
        status: this.context.connections.status(row, false),
      };
    }
    const secrets = await this.store.secretKinds(row.id);
    const signedIn = row.authKind === "oauth" && await mcpSignedIn(this.store, row.id);
    return {
      ...common,
      transport: row.transport,
      url: row.url,
      authKind: row.authKind,
      headerName: row.headerName,
      hasHeaderValue: secrets.has("header_value"),
      oauthClientId: row.oauthClientId,
      hasClientSecret: secrets.has("client_secret"),
      oauthScope: row.oauthScope,
      signedIn,
      status: this.context.connections.status(row, signedIn),
    };
  }

  /** Tells browsers the server as this model read it (`mcp_server_updated`; a repo server's project, `mcp_repo_changed`,
   * as Settings' list is the user's own); its view. */
  async publish(): Promise<McpServerView> {
    const server = await this.view();
    if (this.row.projectId !== null) this.context.broadcast({ type: "mcp_repo_changed", projectId: this.row.projectId });
    else this.context.broadcast({ type: "mcp_server_updated", server });
    return server;
  }

  /** A change to where or how it connects (its transport included) closes its connection; one to where it
   * is or which OAuth client signs in also signs it out (its tokens and registration belong to the old ones). A
   * change to a stdio server's command, arguments, directory, environment or name stops its processes and (but for
   * its name) forgets its tool lists: the next call starts it as changed. */
  async update(changes: unknown): Promise<McpServerView> {
    const update = parseMcpServerInput(McpServerUpdateSchema, changes);
    const before = this.row;
    if (before.projectId !== null) return this.updateRepo(update);
    const fields = validMcpServerFields(changedFields(before, update));
    // The other kind's fields, as their kind's defaults, for comparisons and to clear its secrets.
    const remote = fields.transport === "stdio" ? null : fields;
    const remoteBefore = before.transport === "stdio" ? null : before;
    const stdio = fields.transport === "stdio" ? fields : null;
    const stdioBefore = before.transport === "stdio" ? before : null;
    const secrets = await this.store.secretKinds(this.id);
    if (remote?.authKind === "header" && update.headerValue === null) throw new InvalidMcpServerError("Header authentication needs a value");
    if (remote?.authKind === "header" && !update.headerValue && !(remoteBefore?.authKind === "header" && secrets.has("header_value"))) {
      throw new InvalidMcpServerError("Header authentication needs a value");
    }
    const reauthorize = remote?.url !== remoteBefore?.url || remote?.authKind !== remoteBefore?.authKind || remote?.oauthClientId !== remoteBefore?.oauthClientId;
    const envBefore = await this.env();
    const env = !stdio ? {} : update.env === undefined ? envBefore : mergedEnv(update.env, envBefore);
    const { store } = this;
    // The row first: a name taken by another server then changes nothing.
    withUniqueMcpServerName(fields.name, () => store.update(this.id, fields));
    if (remote?.authKind !== "header") await store.deleteSecrets(this.id, ["header_value"]);
    else if (update.headerValue) await store.setSecret(this.id, "header_value", update.headerValue);
    if (!remote?.oauthClientId || update.oauthClientSecret === null) await store.deleteSecrets(this.id, ["client_secret"]);
    else if (update.oauthClientSecret) await store.setSecret(this.id, "client_secret", update.oauthClientSecret);
    await store.setSecret(this.id, "env", Object.keys(env).length ? JSON.stringify(env) : null);
    if (reauthorize) {
      await store.deleteSecrets(this.id, OAUTH_SECRETS);
      await store.endSignIn(this.id);
    }
    const restart = fields.transport !== before.transport || stdio?.command !== stdioBefore?.command || stdio?.cwd !== stdioBefore?.cwd
      || JSON.stringify(stdio?.args) !== JSON.stringify(stdioBefore?.args) || !sameEnv(env, envBefore);
    if (restart) store.deleteToolLists(this.id);
    const renamed = stdioBefore !== null && fields.name !== before.name;
    const changed = reauthorize || restart || renamed || fields.enabled !== before.enabled || remote?.headerName !== remoteBefore?.headerName
      || update.headerValue !== undefined || update.oauthClientSecret !== undefined || remote?.oauthScope !== remoteBefore?.oauthScope;
    if (changed) await this.context.connections.disconnect(this.id);
    if (renamed) await this.context.stdio.forget(before.name);
    return this.reread().publish();
  }

  /** A repo server's file defines it; whether it may run is the user's toggle, from the browser (`allow`). */
  private async updateRepo(update: McpServerUpdate): Promise<McpServerView> {
    const field = Object.keys(update)[0] ?? "nothing";
    throw new InvalidMcpServerError(field === "enabled"
      ? `${this.name} is defined by its project's .mcp.json: the user turns it on or off in a session's MCP servers list`
      : `${this.name} is defined by its project's .mcp.json: change ${field} there`);
  }

  /** Removes it with its credentials, closing its connections (stopping a stdio server's processes). */
  async remove(): Promise<void> {
    if (this.row.projectId !== null) throw new InvalidMcpServerError(`${this.name} is defined by its project's .mcp.json: remove it there`);
    await this.context.connections.disconnect(this.id);
    if (this.row.transport === "stdio") await this.context.stdio.forget(this.name);
    await this.store.delete(this.id);
    this.context.broadcast({ type: "mcp_server_removed", serverId: this.id });
  }

  /** A stdio server's environment, by name. */
  private async env(): Promise<Record<string, string>> {
    const stored = await this.store.getSecret(this.id, "env");
    const env: Record<string, string> = stored ? JSON.parse(stored) : {};
    return env;
  }

  /** Connects to it afresh, listing its tools (a stdio server's process for the session started again): its view
   * after the attempt (published, as a failure it had may be cleared), and how many tools it listed (null when it
   * failed). */
  async test(signal?: AbortSignal, placement: Placement = {}): Promise<{ server: McpServerView; toolCount: number | null }> {
    const toolCount = await this.context.connections.test(this.id, signal, placement);
    return { server: await this.reread().publish(), toolCount };
  }

  /** Starts a sign-in whose callback is `callbackUrl` (Reins' OAuth callback page as the user's
   * browser reaches it; by default the one of the latest completed sign-in, else `http://localhost:<port>`): the URL to
   * send the user to. A sign-in started earlier stops working. The sign-in completes in `McpServers.finishSignIn`. */
  async startSignIn(callbackUrl = this.defaultCallbackUrl()): Promise<McpSignInStart> {
    const url = await startMcpSignIn(this.store, this.oauthRow(), callbackUrl);
    return { authorizationUrl: url.href, callbackUrl };
  }

  /** The origin of the latest completed sign-in: the callback's path is this code's. */
  private defaultCallbackUrl(): string {
    const latest = this.store.latestRedirectUrl(this.id);
    return `${latest ? new URL(latest).origin : `http://localhost:${process.env.REINS_PORT || "3100"}`}${this.context.callbackPath}`;
  }

  /** Forgets its tokens (its client registration stays, for the next sign-in) and closes its connection. */
  async signOut(): Promise<McpServerView> {
    this.oauthRow();
    await this.store.deleteSecrets(this.id, ["tokens"]);
    await this.store.endSignIn(this.id);
    await this.context.connections.disconnect(this.id);
    return this.reread().publish();
  }

  /** Its tools (name, description, input schema), connecting if needed. Throws
   * `McpServerUnavailableError` when it is disabled, needs sign-in or cannot be reached. */
  listTools(options: { signal?: AbortSignal } & Placement = {}): Promise<McpTool[]> {
    return this.context.connections.listTools(this.id, options);
  }

  /** Calls one of its tools (`McpConnections.callTool`). */
  callTool(name: string, args: Record<string, unknown>, options: CallOptions = {}): Promise<CallToolResult> {
    return this.context.connections.callTool(this.id, name, args, options);
  }

  /** Its row, when it signs in with OAuth; else `McpServerAuthError`. */
  private oauthRow(): McpRemoteRow {
    if (this.row.transport === "stdio" || this.row.authKind !== "oauth") throw new McpServerAuthError(`MCP server ${this.name} does not use OAuth`);
    return this.row;
  }

  /** The server as it is now. */
  private reread(): McpServerModel {
    return this.servers.get(this.id);
  }
}

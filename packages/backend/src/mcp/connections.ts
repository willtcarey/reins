/**
 * The connections to remote MCP servers of one app (docs/dev/mcp-servers.md *Connections*, *Where
 * connections live*): at most one per server, opened on demand, shared by every caller, closed once idle,
 * on a change to the server and when the app stops. It reads each server's configuration and credentials from
 * the store when it connects.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolResultSchema, ErrorCode, McpError, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { getMcpSecret, getMcpServer, listMcpServers, type McpServerRow } from "../mcp-server-store.js";
import { mcpSignedIn, McpOAuthProvider, McpRefreshLock, oauthConnectionFetch, refreshAgedMcpTokens } from "./oauth-provider.js";
import { logger } from "../logger.js";

/**
 * Whether agents can use a server, and if not, why: `disabled` by the user; `needs_sign_in` (OAuth, with no
 * tokens, tokens that no longer refresh, or an expired access token without a refresh token); `error`, its
 * latest attempt or request having failed (`message` says why); else `ready`. The connection is not part
 * of it: one is opened on demand.
 */
export type McpServerStatus =
  | { state: "ready" }
  | { state: "needs_sign_in" }
  | { state: "error"; message: string }
  | { state: "disabled" };

/** A tool as the server lists it: its name, description and the JSON Schema of its arguments. */
export type McpTool = Pick<Tool, "name" | "title" | "description" | "inputSchema" | "outputSchema" | "annotations">;

/** Thrown when a server cannot be used now: disabled, needing sign-in, or failing (`status`). */
export class McpServerUnavailableError extends Error {
  constructor(readonly serverName: string, readonly status: Exclude<McpServerStatus, { state: "ready" }>) {
    super(status.state === "disabled" ? `MCP server ${serverName} is disabled`
      : status.state === "needs_sign_in" ? `MCP server ${serverName} needs sign-in`
      : `MCP server ${serverName} is unavailable: ${status.message}`);
    this.name = "McpServerUnavailableError";
  }
}

export interface McpConnectionOptions {
  /** A connection no call used for this long is closed. */
  idleMs?: number;
  /** Connecting (the transport and `initialize`) is given this long. */
  connectTimeoutMs?: number;
  /** A request without a timeout of its own (listing tools; a tool call unless given `timeoutMs`). */
  requestTimeoutMs?: number;
  /** How often it looks for OAuth tokens to refresh in the background; the first look is at most a minute
   * after it starts, since a reload starts it again. */
  tokenRefreshCheckMs?: number;
  /** Tokens issued longer ago than this are refreshed in the background. */
  tokenRefreshAgeMs?: number;
}

export interface CallOptions { signal?: AbortSignal; timeoutMs?: number }

const DEFAULTS: Required<McpConnectionOptions> = {
  idleMs: 5 * 60_000, connectTimeoutMs: 15_000, requestTimeoutMs: 60_000,
  // Shorter than the shortest idle lifetime of refresh tokens that authorization servers commonly set
  // (about a week), so that one missed check does not matter.
  tokenRefreshCheckMs: 60 * 60_000, tokenRefreshAgeMs: 24 * 60 * 60_000,
};

interface Connection {
  client: Client;
  /** The tool list while it is known: listed on first use, forgotten on `tools/list_changed`. */
  tools: Promise<McpTool[]> | null;
}

interface Entry {
  connection: Connection | null;
  connecting: Promise<Connection> | null;
  /** The latest failure, until a connection succeeds or the server changes. */
  failure: McpServerUnavailableError | null;
  inFlight: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** Bumped by `disconnect`: a connection opened for an earlier generation is closed, not kept. */
  generation: number;
}

export class McpConnections {
  private readonly entries = new Map<number, Entry>();
  private readonly options: Required<McpConnectionOptions>;
  private readonly refreshLock = new McpRefreshLock();
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  /** `changed` is told when a server's status changes without a change to it: a failure is recorded or
   * cleared, or a background refresh signs it out. An expiring access token is not told: the next read
   * of the status shows it. */
  constructor(private readonly changed: (serverId: number) => void, options: McpConnectionOptions = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.scheduleTokenRefresh(Math.min(60_000, this.options.tokenRefreshCheckMs));
  }

  /** The status of `server`, as the caller read its row and whether it is signed in (`mcpSignedIn`). */
  status(server: McpServerRow, signedIn: boolean): McpServerStatus {
    return configurationBlock(server, signedIn) ?? this.entries.get(server.id)?.failure?.status ?? { state: "ready" };
  }

  /** Connects to the server afresh (closing a connection it has) and lists its tools: how many, or null
   * when it failed (the failure is recorded in its status). */
  async test(serverId: number, signal?: AbortSignal): Promise<number | null> {
    await this.disconnect(serverId);
    try {
      return await this.use(serverId, signal, async connection => (await abortable(this.toolsOf(connection), signal)).length);
    } catch (error) {
      if (!(error instanceof McpServerUnavailableError)) throw error;
      return null;
    }
  }

  /** The server's tools, from its connection's cache when it has one. */
  listTools(serverId: number, { signal }: { signal?: AbortSignal } = {}): Promise<McpTool[]> {
    return this.use(serverId, signal, connection => abortable(this.toolsOf(connection), signal));
  }

  /** Calls a tool. Throws `McpServerUnavailableError` when the server cannot be reached, and the SDK's
   * `McpError` for the server's JSON-RPC errors (an unknown tool, invalid arguments, a timeout: code
   * `RequestTimeout`). The result is the SDK's `CallToolResult`: content blocks, structured content, and
   * `isError` for a failure the tool itself reports. */
  callTool(serverId: number, name: string, args: Record<string, unknown>, { signal, timeoutMs }: CallOptions = {}): Promise<CallToolResult> {
    return this.use(serverId, signal, async ({ client }) => {
      const result = await client.callTool({ name, arguments: args }, undefined, { signal, timeout: timeoutMs ?? this.options.requestTimeoutMs });
      const parsed = CallToolResultSchema.safeParse(result);
      if (parsed.success) return parsed.data;
      // A server on a protocol version before content blocks answers `toolResult`.
      return { content: [{ type: "text", text: JSON.stringify("toolResult" in result ? result.toolResult : result) }] };
    });
  }

  /** Closes the server's connection and forgets its failure: after a change to it, signing out, or its
   * removal. A call in flight on it fails. It does not tell `changed`: its callers publish the server. */
  async disconnect(serverId: number): Promise<void> {
    const entry = this.entries.get(serverId);
    if (!entry) return;
    entry.generation++;
    entry.failure = null;
    entry.connecting = null;
    await this.drop(entry);
  }

  /** The app stops: every connection is closed, and nothing connects again. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    await Promise.all([...this.entries.keys()].map(serverId => this.disconnect(serverId)));
    this.entries.clear();
  }

  private scheduleTokenRefresh(delayMs: number) {
    if (this.closed) return;
    this.refreshTimer = setTimeout(() => {
      void this.refreshAgedTokens().finally(() => this.scheduleTokenRefresh(this.options.tokenRefreshCheckMs));
    }, delayMs);
    this.refreshTimer.unref?.();
  }

  /** Keeps the enabled OAuth servers signed in while nobody uses them: their refresh tokens could expire
   * unused. A disabled server is not contacted. */
  private async refreshAgedTokens(): Promise<void> {
    let servers: McpServerRow[];
    try {
      servers = listMcpServers().filter(server => server.enabled && server.authKind === "oauth");
    } catch (error) {
      logger.warn(`Looking for MCP tokens to refresh failed: ${describe(error)}`);
      return;
    }
    for (const server of servers) {
      if (this.closed) return;
      const result = await refreshAgedMcpTokens(server, this.refreshLock, this.options.tokenRefreshAgeMs / 1000)
        .catch((error: unknown) => { logger.warn(`Refreshing MCP server ${server.name}'s tokens failed: ${describe(error)}`); return null; });
      if (result === "failed") logger.warn(`Refreshing MCP server ${server.name}'s tokens failed; it is tried again at the next check`);
      if (result === "signed_out") {
        logger.info(`MCP server ${server.name} needs sign-in: its authorization server refused to refresh its tokens`);
        this.changed(server.id);
      }
    }
  }

  /** Runs `work` on the server's connection, connecting first if needed. A request that finds the
   * connection's MCP session gone (the server restarted: 404) was not run, so it is run once more on a
   * new connection. */
  private async use<T>(serverId: number, signal: AbortSignal | undefined, work: (connection: Connection) => Promise<T>): Promise<T> {
    const entry = this.entryOf(serverId);
    entry.inFlight++;
    this.clearIdle(entry);
    try {
      for (let attempt = 0; ; attempt++) {
        const connection = await this.connection(serverId, entry, signal);
        try {
          return await work(connection);
        } catch (error) {
          const handled = await this.requestFailed(serverId, entry, connection, error, signal);
          if (handled === "retry" && attempt === 0) continue;
          throw handled === "retry" ? this.failure(serverId, entry, error) : handled;
        }
      }
    } finally {
      entry.inFlight--;
      this.scheduleIdle(entry);
    }
  }

  private entryOf(serverId: number): Entry {
    let entry = this.entries.get(serverId);
    if (!entry) {
      entry = { connection: null, connecting: null, failure: null, inFlight: 0, idleTimer: null, generation: 0 };
      this.entries.set(serverId, entry);
    }
    return entry;
  }

  private async connection(serverId: number, entry: Entry, signal: AbortSignal | undefined): Promise<Connection> {
    signal?.throwIfAborted();
    if (this.closed) throw new Error("MCP connections are closed (the server is reloading)");
    const server = getMcpServer(serverId);
    // Callers find the server first (the model), so only a removal since then lands here.
    if (!server) throw new Error(`MCP server ${serverId} was removed`);
    const blocked = configurationBlock(server, mcpSignedIn(server.id));
    if (blocked) throw new McpServerUnavailableError(server.name, blocked);
    if (entry.connection) return entry.connection;
    if (!entry.connecting) {
      const connecting = this.open(server, entry);
      entry.connecting = connecting;
      void connecting.catch(() => undefined).finally(() => { if (entry.connecting === connecting) entry.connecting = null; });
    }
    return abortable(entry.connecting, signal);
  }

  private async open(server: McpServerRow, entry: Entry): Promise<Connection> {
    const generation = entry.generation;
    let connection: Connection;
    try {
      connection = await this.connect(server, entry);
    } catch (error) {
      if (generation !== entry.generation) throw error;
      throw this.failure(server.id, entry, error);
    }
    if (generation !== entry.generation || this.closed) {
      await connection.client.close().catch(() => undefined);
      throw new Error(`MCP server ${server.name} changed while connecting`);
    }
    entry.connection = connection;
    if (entry.failure) {
      entry.failure = null;
      this.changed(server.id);
    }
    return connection;
  }

  /** Connects over the server's transport (`transportFor`). */
  private async connect(server: McpServerRow, entry: Entry): Promise<Connection> {
    const authProvider = server.authKind === "oauth" ? new McpOAuthProvider(server, { kind: "connection" }) : undefined;
    const transport = transportFor(server, {
      requestInit: headerRequestInit(server),
      authProvider,
      fetch: authProvider ? oauthConnectionFetch(server, this.refreshLock) : undefined,
    });
    const connection: Connection = { client: undefined!, tools: null };
    connection.client = new Client({ name: "reins", version: "1.0.0" }, {
      capabilities: {},
      listChanged: { tools: { autoRefresh: false, debounceMs: 100, onChanged: () => { connection.tools = null; } } },
    });
    connection.client.onclose = () => { if (entry.connection === connection) entry.connection = null; };
    connection.client.onerror = (error) => logger.debug(`MCP server ${server.name}: ${error.message}`);
    try {
      await connection.client.connect(transport, { timeout: this.options.connectTimeoutMs });
    } catch (error) {
      await connection.client.close().catch(() => undefined);
      if (authProvider?.signInRequired) throw new UnauthorizedError();
      if (server.transport === "http" && refusedAsLegacy(error)) {
        throw new Error(`${describe(error)}. If this is a legacy HTTP+SSE server, set its transport to SSE.`, { cause: error });
      }
      throw error;
    }
    return connection;
  }

  /** What a failed request means: `"retry"` when its session was gone (not run); else the error to throw.
   * The server's own JSON-RPC errors, a timeout and the caller's abort leave the connection open; anything
   * else (unreachable, refused, wanting a sign-in, the connection closed) closes it, and the next call
   * connects again. */
  private async requestFailed(serverId: number, entry: Entry, connection: Connection, error: unknown, signal: AbortSignal | undefined): Promise<"retry" | unknown> {
    if (error instanceof StreamableHTTPError && error.code === 404) {
      await this.drop(entry, connection);
      return "retry";
    }
    if (signal?.aborted) return error;
    if (error instanceof McpError && error.code !== ErrorCode.ConnectionClosed) return error;
    await this.drop(entry, connection);
    return this.failure(serverId, entry, error);
  }

  /** Records why the server cannot be used, and tells. */
  private failure(serverId: number, entry: Entry, error: unknown): McpServerUnavailableError {
    if (error instanceof McpServerUnavailableError) return error;
    const name = getMcpServer(serverId)?.name ?? String(serverId);
    const status: McpServerUnavailableError["status"] = error instanceof UnauthorizedError
      ? { state: "needs_sign_in" }
      : { state: "error", message: describe(error) };
    entry.failure = new McpServerUnavailableError(name, status);
    this.changed(serverId);
    return entry.failure;
  }

  /** The listing is shared by every caller, so no caller's signal stops it: one that gives up (a search
   * past its deadline) leaves it to finish for the next. */
  private toolsOf(connection: Connection): Promise<McpTool[]> {
    if (!connection.tools) {
      const listing = this.listAll(connection.client);
      connection.tools = listing;
      listing.catch(() => { if (connection.tools === listing) connection.tools = null; });
    }
    return connection.tools;
  }

  private async listAll(client: Client): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: this.options.requestTimeoutMs });
      for (const { name, title, description, inputSchema, outputSchema, annotations } of page.tools) {
        tools.push({ name, title, description, inputSchema, outputSchema, annotations });
      }
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }

  private async drop(entry: Entry, connection = entry.connection) {
    this.clearIdle(entry);
    if (!connection) return;
    if (entry.connection === connection) entry.connection = null;
    await connection.client.close().catch(() => undefined);
  }

  private clearIdle(entry: Entry) {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }

  private scheduleIdle(entry: Entry) {
    if (entry.inFlight > 0 || !entry.connection || this.closed) return;
    this.clearIdle(entry);
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = null;
      if (entry.inFlight === 0) void this.drop(entry);
    }, this.options.idleMs);
    entry.idleTimer.unref?.();
  }
}

interface TransportOptions {
  requestInit: RequestInit | undefined;
  authProvider: McpOAuthProvider | undefined;
  fetch: FetchLike | undefined;
}

/** The one place a transport kind becomes a transport. */
function transportFor(server: McpServerRow, options: TransportOptions): Transport {
  const url = new URL(server.url);
  switch (server.transport) {
    case "http": return new StreamableHTTPClientTransport(url, options);
    case "sse": return new SSEClientTransport(url, options);
  }
}

function headerRequestInit(server: McpServerRow): RequestInit | undefined {
  if (server.authKind !== "header" || !server.headerName) return undefined;
  const value = getMcpSecret(server.id, "header_value");
  return value === null ? undefined : { headers: { [server.headerName]: value } };
}

/** What a legacy HTTP+SSE server answers a streamable HTTP client's first POST (404, 405), as does a wrong
 * path: a 4xx other than authentication. */
function refusedAsLegacy(error: unknown): boolean {
  return error instanceof StreamableHTTPError && error.code !== undefined && error.code >= 400 && error.code < 500
    && error.code !== 401 && error.code !== 403;
}

/** What the server's configuration alone says: disabled, or OAuth without usable tokens. */
function configurationBlock(server: McpServerRow, signedIn: boolean): McpServerUnavailableError["status"] | null {
  if (!server.enabled) return { state: "disabled" };
  if (server.authKind === "oauth" && !signedIn) return { state: "needs_sign_in" };
  return null;
}

function describe(error: unknown): string {
  if (error instanceof StreamableHTTPError && error.code !== undefined) {
    const detail = error.message.replace(/^Streamable HTTP error: (Error POSTing to endpoint: )?/, "").trim();
    return `The server answered HTTP ${error.code}${detail ? `: ${detail}` : ""}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** `promise`, or the caller's abort: a shared connection attempt goes on for its other callers. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

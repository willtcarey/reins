/**
 * The connections to MCP servers of one app (docs/dev/mcp-servers.md *Connections*, *Where connections live*):
 * at most one per remote server, shared by every caller, and one per stdio server and calling session (its process
 * in the session's checkout), shared by the session's calls; opened on demand, closed once idle, on a change to the server and when the app stops. It reads each server's configuration
 * and credentials from the store when it connects. A stdio server's tool list is kept in the store, so it is known
 * while its process is stopped; its process is `McpStdio`'s (stdio.ts), the OAuth background refresh
 * `McpTokenRefresher`'s (oauth-provider.ts).
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolResultSchema, ErrorCode, McpError, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "@reins/sdk/server";
import type { McpRemoteRow, McpServerRow, McpStore } from "./store.js";
import { McpServerSessionRequiredError, NodeProcessTransport, type McpStdio } from "./stdio.js";
import { mcpSignedIn, McpOAuthProvider, oauthConnectionFetch, type McpRefreshLock } from "./oauth-provider.js";

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
  /** A connection no call used for this long is closed (a stdio server's process stopped). */
  idleMs?: number;
  /** Connecting (the transport and `initialize`) is given this long. */
  connectTimeoutMs?: number;
  /** Starting a stdio server and its `initialize`: longer, as `npx -y` may download it first. */
  stdioConnectTimeoutMs?: number;
  /** A request without a timeout of its own (listing tools; a tool call unless given `timeoutMs`). */
  requestTimeoutMs?: number;
}

/** The calling session: a stdio server runs a process for each, in its checkout. Null or left out for none (a
 * remote server needs none). */
export interface Placement { sessionId?: string | null }
export interface CallOptions extends Placement { signal?: AbortSignal; timeoutMs?: number }

const DEFAULTS: Required<McpConnectionOptions> = {
  idleMs: 5 * 60_000, connectTimeoutMs: 15_000, stdioConnectTimeoutMs: 60_000, requestTimeoutMs: 60_000,
};

interface Connection {
  client: Client;
  entry: Entry;
  /** A stdio server's: why its process ended. */
  stdio: NodeProcessTransport | null;
  /** The tool list while it is known: listed on first use (a stdio server's when it connects), forgotten on
   * `tools/list_changed` (a stdio server's listed again then). */
  tools: Promise<McpTool[]> | null;
}

/** A remote server's connection (`sessionId` null), or a stdio server's for one session. */
interface Entry {
  serverId: number;
  sessionId: string | null;
  connection: Connection | null;
  connecting: Promise<Connection> | null;
  inFlight: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** Bumped by `disconnect`: a connection opened for an earlier generation is closed, not kept. */
  generation: number;
}

export class McpConnections {
  /** By `entryKey`. */
  private readonly entries = new Map<string, Entry>();
  /** Each server's latest failure, until a connection of it succeeds or it changes: a stdio server's in any session. */
  private readonly failures = new Map<number, McpServerUnavailableError>();
  private readonly options: Required<McpConnectionOptions>;
  private closed = false;

  /** `changed` is told when a server's status changes without a change to it: a failure is recorded or
   * cleared. An expiring access token is not told: the next read of the status shows it. `refreshLock`
   * serializes token refreshes with the background ones (`McpTokenRefresher`). */
  constructor(
    private readonly store: McpStore,
    private readonly logger: Logger,
    private readonly changed: (serverId: number) => void,
    private readonly stdio: McpStdio,
    private readonly refreshLock: McpRefreshLock,
    options: McpConnectionOptions = {},
  ) {
    this.options = { ...DEFAULTS, ...options };
  }

  /** The status of `server`, as the caller read its row and whether it is signed in (`mcpSignedIn`). */
  status(server: McpServerRow, signedIn: boolean): McpServerStatus {
    return configurationBlock(server, signedIn) ?? this.failures.get(server.id)?.status ?? { state: "ready" };
  }

  /** Connects to the server afresh (closing a connection it has; a stdio server's process for the session started
   * again) and lists its tools: how many, or null when it failed (the failure is recorded in its status). */
  async test(serverId: number, signal?: AbortSignal, { sessionId = null }: Placement = {}): Promise<number | null> {
    if (this.store.get(serverId)?.transport === "stdio") {
      const entry = sessionId ? this.entries.get(entryKey(serverId, sessionId)) : undefined;
      if (entry) await this.reset(entry);
    } else {
      await this.disconnect(serverId);
    }
    try {
      return await this.use(serverId, sessionId, signal, async connection => (await abortable(this.toolsOf(connection), signal)).length);
    } catch (error) {
      if (!(error instanceof McpServerUnavailableError)) throw error;
      return null;
    }
  }

  /** The server's tools, from its connection's cache when it has one. A stdio server's when the session's process is
   * not running are those it listed last, in any session, without starting it. */
  listTools(serverId: number, { signal, sessionId = null }: { signal?: AbortSignal } & Placement = {}): Promise<McpTool[]> {
    const server = this.store.get(serverId);
    if (server?.transport === "stdio" && !(sessionId && this.entries.get(entryKey(serverId, sessionId))?.connection)) {
      const blocked = configurationBlock(server, true);
      if (blocked) return Promise.reject(new McpServerUnavailableError(server.name, blocked));
      const kept = this.store.toolLists(serverId)[0];
      if (kept) {
        const tools: McpTool[] = JSON.parse(kept.tools);
        return Promise.resolve(tools);
      }
    }
    return this.use(serverId, sessionId, signal, connection => abortable(this.toolsOf(connection), signal));
  }

  /** Calls a tool. Throws `McpServerUnavailableError` when the server cannot be reached, and the SDK's
   * `McpError` for the server's JSON-RPC errors (an unknown tool, invalid arguments, a timeout: code
   * `RequestTimeout`). The result is the SDK's `CallToolResult`: content blocks, structured content, and
   * `isError` for a failure the tool itself reports. */
  callTool(serverId: number, name: string, args: Record<string, unknown>, { signal, timeoutMs, sessionId = null }: CallOptions = {}): Promise<CallToolResult> {
    return this.use(serverId, sessionId, signal, async ({ client }) => {
      const result = await client.callTool({ name, arguments: args }, undefined, { signal, timeout: timeoutMs ?? this.options.requestTimeoutMs });
      const parsed = CallToolResultSchema.safeParse(result);
      if (parsed.success) return parsed.data;
      // A server on a protocol version before content blocks answers `toolResult`.
      return { content: [{ type: "text", text: JSON.stringify("toolResult" in result ? result.toolResult : result) }] };
    });
  }

  /** Closes the server's connections (stopping a stdio server's processes) and forgets its failure: after a change
   * to it, signing out, or its removal. A call in flight on one fails. It does not tell `changed`: its callers
   * publish the server. */
  async disconnect(serverId: number): Promise<void> {
    this.failures.delete(serverId);
    await Promise.all([...this.entries.values()].filter(entry => entry.serverId === serverId).map(entry => this.reset(entry)));
  }

  /** The app stops: every connection is closed, and nothing connects again. */
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.entries.values()].map(entry => this.reset(entry)));
    this.entries.clear();
    this.failures.clear();
  }

  private async reset(entry: Entry): Promise<void> {
    entry.generation++;
    entry.connecting = null;
    await this.drop(entry);
  }

  /** Runs `work` on the server's connection, connecting first if needed. A request that finds the
   * connection's MCP session gone (the server restarted: 404) was not run, so it is run once more on a
   * new connection. */
  private async use<T>(serverId: number, sessionId: string | null, signal: AbortSignal | undefined, work: (connection: Connection) => Promise<T>): Promise<T> {
    const server = this.store.get(serverId);
    // Callers find the server first (the model), so only a removal since then lands here.
    if (!server) throw new Error(`MCP server ${serverId} was removed`);
    const stdio = server.transport === "stdio";
    if (stdio && !sessionId) {
      const blocked = configurationBlock(server, true);
      throw blocked ? new McpServerUnavailableError(server.name, blocked) : new McpServerSessionRequiredError(server.name);
    }
    const entry = this.entryOf(serverId, stdio ? sessionId : null);
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
          throw handled === "retry" ? this.failure(serverId, error) : handled;
        }
      }
    } finally {
      entry.inFlight--;
      this.scheduleIdle(entry);
    }
  }

  private entryOf(serverId: number, sessionId: string | null): Entry {
    const key = entryKey(serverId, sessionId);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { serverId, sessionId, connection: null, connecting: null, inFlight: 0, idleTimer: null, generation: 0 };
      this.entries.set(key, entry);
    }
    return entry;
  }

  private async connection(serverId: number, entry: Entry, signal: AbortSignal | undefined): Promise<Connection> {
    signal?.throwIfAborted();
    if (this.closed) throw new Error("MCP connections are closed (the server is reloading)");
    const server = this.store.get(serverId);
    // Callers find the server first (the model), so only a removal since then lands here.
    if (!server) throw new Error(`MCP server ${serverId} was removed`);
    const blocked = configurationBlock(server, await mcpSignedIn(this.store, server.id));
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
      throw this.failure(server.id, error);
    }
    if (generation !== entry.generation || this.closed) {
      await connection.client.close().catch(() => undefined);
      throw new Error(`MCP server ${server.name} changed while connecting`);
    }
    entry.connection = connection;
    if (this.failures.delete(server.id)) this.changed(server.id);
    return connection;
  }

  /** Connects over the server's transport (`transportFor`); a stdio server's tool list is listed and kept then. */
  private async connect(server: McpServerRow, entry: Entry): Promise<Connection> {
    const { transport, authProvider } = await this.transportFor(server, entry);
    const stdio = transport instanceof NodeProcessTransport ? transport : null;
    const connection: Connection = { client: undefined!, entry, stdio, tools: null };
    connection.client = new Client({ name: "reins", version: "1.0.0" }, {
      capabilities: {},
      listChanged: {
        tools: {
          autoRefresh: false, debounceMs: 100,
          onChanged: () => {
            connection.tools = null;
            if (stdio) void this.toolsOf(connection).catch(() => undefined);
          },
        },
      },
    });
    connection.client.onclose = () => { if (entry.connection === connection) entry.connection = null; };
    connection.client.onerror = (error) => this.logger.debug(`MCP server ${server.name}: ${error.message}`);
    try {
      await connection.client.connect(transport, { timeout: stdio ? this.options.stdioConnectTimeoutMs : this.options.connectTimeoutMs });
      if (stdio) await this.toolsOf(connection);
    } catch (error) {
      await connection.client.close().catch(() => undefined);
      if (authProvider?.signInRequired) throw new UnauthorizedError();
      if (server.transport === "http" && refusedAsLegacy(error)) {
        throw new Error(`${describe(error)}. If this is a legacy HTTP+SSE server, set its transport to SSE.`, { cause: error });
      }
      if (stdio?.endReason) throw new Error(stdio.endReason, { cause: error });
      throw error;
    }
    return connection;
  }

  /** The one place a transport kind becomes a transport: a remote server's with its credentials (an OAuth server's
   * provider, which a failure reads), a stdio server's process for the entry's session. */
  private async transportFor(server: McpServerRow, entry: Entry): Promise<{ transport: Transport; authProvider?: McpOAuthProvider }> {
    if (server.transport === "stdio") return { transport: new NodeProcessTransport(() => this.stdio.start(server, entry.sessionId!)) };
    const authProvider = server.authKind === "oauth" ? new McpOAuthProvider(this.store, server, { kind: "connection" }) : undefined;
    const options = {
      requestInit: headerRequestInit(server, await this.store.getSecret(server.id, "header_value")),
      authProvider,
      fetch: authProvider ? oauthConnectionFetch(this.store, server, this.refreshLock) : undefined,
    };
    const url = new URL(server.url);
    return { transport: server.transport === "http" ? new StreamableHTTPClientTransport(url, options) : new SSEClientTransport(url, options), authProvider };
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
    const ended = connection.stdio?.endReason;
    return this.failure(serverId, ended ? new Error(ended, { cause: error }) : error);
  }

  /** Records why the server cannot be used, and tells. */
  private failure(serverId: number, error: unknown): McpServerUnavailableError {
    if (error instanceof McpServerUnavailableError) return error;
    const name = this.store.get(serverId)?.name ?? String(serverId);
    const status: McpServerUnavailableError["status"] = error instanceof UnauthorizedError
      ? { state: "needs_sign_in" }
      : { state: "error", message: describe(error) };
    const failure = new McpServerUnavailableError(name, status);
    this.failures.set(serverId, failure);
    this.changed(serverId);
    return failure;
  }

  /** The listing is shared by every caller, so no caller's signal stops it: one that gives up (a search
   * past its deadline) leaves it to finish for the next. A stdio server's is kept for its node, unless the
   * server changed meanwhile. */
  private toolsOf(connection: Connection): Promise<McpTool[]> {
    if (!connection.tools) {
      const { entry } = connection;
      const generation = entry.generation;
      const listing = this.listAll(connection.client);
      connection.tools = listing;
      listing.then(tools => {
        const nodeId = connection.stdio?.nodeId;
        if (!nodeId || generation !== entry.generation || this.closed) return;
        try {
          this.store.setToolList(entry.serverId, nodeId, JSON.stringify(tools));
        } catch (error) {
          this.logger.warn(`Keeping MCP server ${entry.serverId}'s tool list failed: ${describe(error)}`);
        }
      }, () => { if (connection.tools === listing) connection.tools = null; });
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

function entryKey(serverId: number, sessionId: string | null): string {
  return sessionId === null ? String(serverId) : `${serverId}:${sessionId}`;
}

function headerRequestInit(server: McpRemoteRow, value: string | null): RequestInit | undefined {
  if (server.authKind !== "header" || !server.headerName) return undefined;
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
  if (server.transport !== "stdio" && server.authKind === "oauth" && !signedIn) return { state: "needs_sign_in" };
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

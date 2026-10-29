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
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolResultSchema, ErrorCode, McpError, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { getMcpSecret, getMcpServer, mcpSecretKinds, type McpServerRow } from "../mcp-server-store.js";
import { McpOAuthProvider, oauthConnectionFetch } from "./oauth-provider.js";
import { logger } from "../logger.js";

/**
 * A server as Reins can use it now: `disabled` by the user; `needs_sign_in` (OAuth, with no tokens or
 * tokens that no longer refresh); `not_connected` (nothing tried yet, or closed when idle); `connecting`;
 * `connected`; `error`, its latest attempt or request having failed (`message` says why).
 */
export type McpServerStatus =
  | { state: "disabled" }
  | { state: "needs_sign_in" }
  | { state: "not_connected" }
  | { state: "connecting" }
  | { state: "connected" }
  | { state: "error"; message: string };

/** A tool as the server lists it: its name, description and the JSON Schema of its arguments. */
export type McpTool = Pick<Tool, "name" | "title" | "description" | "inputSchema" | "outputSchema" | "annotations">;

/** Thrown when a server cannot be used now: disabled, needing sign-in, or failing (`status`). */
export class McpServerUnavailableError extends Error {
  constructor(readonly serverName: string, readonly status: Exclude<McpServerStatus, { state: "connected" | "connecting" | "not_connected" }>) {
    super(status.state === "disabled" ? `MCP server ${serverName} is disabled`
      : status.state === "needs_sign_in" ? `MCP server ${serverName} needs sign-in`
      : `MCP server ${serverName} is unavailable: ${status.message}`);
    this.name = "McpServerUnavailableError";
  }
}

export class McpServerNotFoundError extends Error {
  constructor(server: number | string, known?: readonly string[]) {
    super(`MCP server not found: ${server}${known ? ` (the servers: ${known.length ? known.join(", ") : "none"})` : ""}`);
    this.name = "McpServerNotFoundError";
  }
}

export interface McpConnectionOptions {
  /** A connection no call used for this long is closed. */
  idleMs?: number;
  /** Connecting (the transport and `initialize`) is given this long. */
  connectTimeoutMs?: number;
  /** A request without a timeout of its own (listing tools; a tool call unless given `timeoutMs`). */
  requestTimeoutMs?: number;
}

export interface CallOptions { signal?: AbortSignal; timeoutMs?: number }

const DEFAULTS: Required<McpConnectionOptions> = { idleMs: 5 * 60_000, connectTimeoutMs: 15_000, requestTimeoutMs: 60_000 };

interface Connection {
  client: Client;
  /** The tool list while it is known: listed on first use, again after `tools/list_changed`. */
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
  /** The tool count of the last list, for views. */
  toolCount: number | null;
}

export class McpConnections {
  private readonly entries = new Map<number, Entry>();
  private readonly options: Required<McpConnectionOptions>;
  private closed = false;

  /** `changed` is told whenever a server's status or tool list may have changed. */
  constructor(private readonly changed: (serverId: number) => void, options: McpConnectionOptions = {}) {
    this.options = { ...DEFAULTS, ...options };
  }

  status(serverId: number): McpServerStatus {
    const server = getMcpServer(serverId);
    if (!server) throw new McpServerNotFoundError(serverId);
    const blocked = configurationBlock(server);
    if (blocked) return blocked;
    const entry = this.entries.get(serverId);
    if (entry?.connection) return { state: "connected" };
    if (entry?.connecting) return { state: "connecting" };
    if (entry?.failure) return entry.failure.status;
    return { state: "not_connected" };
  }

  /** How many tools it listed last, or null before it listed any. */
  toolCount(serverId: number): number | null {
    return this.entries.get(serverId)?.toolCount ?? null;
  }

  /** Connects to the server afresh (closing a connection it has); its status after the attempt. */
  async test(serverId: number, signal?: AbortSignal): Promise<McpServerStatus> {
    await this.disconnect(serverId);
    try {
      await this.use(serverId, signal, async (connection) => { await abortable(this.toolsOf(serverId, connection), signal); });
    } catch (error) {
      if (!(error instanceof McpServerUnavailableError)) throw error;
    }
    return this.status(serverId);
  }

  /** The server's tools, from its connection's cache when it has one. */
  listTools(serverId: number, { signal }: { signal?: AbortSignal } = {}): Promise<McpTool[]> {
    return this.use(serverId, signal, connection => abortable(this.toolsOf(serverId, connection), signal));
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
   * removal. A call in flight on it fails. */
  async disconnect(serverId: number): Promise<void> {
    const entry = this.entries.get(serverId);
    if (!entry) return;
    entry.generation++;
    entry.failure = null;
    entry.connecting = null;
    entry.toolCount = null;
    await this.drop(serverId, entry);
  }

  /** The app stops: every connection is closed, and nothing connects again. */
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.entries.keys()].map(serverId => this.disconnect(serverId)));
    this.entries.clear();
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
      this.scheduleIdle(serverId, entry);
    }
  }

  private entryOf(serverId: number): Entry {
    let entry = this.entries.get(serverId);
    if (!entry) {
      entry = { connection: null, connecting: null, failure: null, inFlight: 0, idleTimer: null, generation: 0, toolCount: null };
      this.entries.set(serverId, entry);
    }
    return entry;
  }

  private async connection(serverId: number, entry: Entry, signal: AbortSignal | undefined): Promise<Connection> {
    signal?.throwIfAborted();
    if (this.closed) throw new Error("MCP connections are closed (the server is reloading)");
    const server = getMcpServer(serverId);
    if (!server) throw new McpServerNotFoundError(serverId);
    const blocked = configurationBlock(server);
    if (blocked) throw new McpServerUnavailableError(server.name, blocked);
    if (entry.connection) return entry.connection;
    if (!entry.connecting) {
      const connecting = this.open(server, entry);
      entry.connecting = connecting;
      void connecting.catch(() => undefined).finally(() => { if (entry.connecting === connecting) entry.connecting = null; });
      this.changed(serverId);
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
    entry.failure = null;
    this.changed(server.id);
    return connection;
  }

  /** Streamable HTTP, else the legacy HTTP+SSE transport when the server refuses its first POST as a
   * legacy server does (4xx other than authentication). */
  private async connect(server: McpServerRow, entry: Entry): Promise<Connection> {
    const url = new URL(server.url);
    const headerValue = server.authKind === "header" && server.headerName ? getMcpSecret(server.id, "header_value") : null;
    const requestInit: RequestInit | undefined = headerValue !== null && server.headerName ? { headers: { [server.headerName]: headerValue } } : undefined;
    const authProvider = server.authKind === "oauth" ? new McpOAuthProvider(server, { kind: "connection" }) : undefined;
    const fetch = authProvider ? oauthConnectionFetch(server, authProvider) : undefined;
    const attempt = async (transport: Transport): Promise<Connection> => {
      const connection: Connection = { client: undefined!, tools: null };
      connection.client = new Client({ name: "reins", version: "1.0.0" }, {
        capabilities: {},
        listChanged: { tools: { autoRefresh: false, debounceMs: 100, onChanged: () => this.toolsChanged(server.id, entry, connection) } },
      });
      connection.client.onclose = () => this.connectionClosed(server.id, entry, connection);
      connection.client.onerror = (error) => logger.debug(`MCP server ${server.name}: ${error.message}`);
      try {
        await connection.client.connect(transport, { timeout: this.options.connectTimeoutMs });
      } catch (error) {
        await connection.client.close().catch(() => undefined);
        if (authProvider?.signInRequired) throw new UnauthorizedError();
        throw error;
      }
      return connection;
    };
    try {
      return await attempt(new StreamableHTTPClientTransport(url, { requestInit, authProvider, fetch }));
    } catch (error) {
      const legacy = error instanceof StreamableHTTPError && error.code !== undefined && error.code >= 400 && error.code < 500 && error.code !== 401 && error.code !== 403;
      if (!legacy) throw error;
      return attempt(new SSEClientTransport(url, { requestInit, authProvider, fetch }));
    }
  }

  /** What a failed request means: `"retry"` when its session was gone (not run); else the error to throw.
   * The server's own JSON-RPC errors, a timeout and the caller's abort leave the connection open; anything
   * else (unreachable, refused, wanting a sign-in, the connection closed) closes it, and the next call
   * connects again. */
  private async requestFailed(serverId: number, entry: Entry, connection: Connection, error: unknown, signal: AbortSignal | undefined): Promise<"retry" | unknown> {
    if (error instanceof StreamableHTTPError && error.code === 404) {
      await this.drop(serverId, entry, connection);
      return "retry";
    }
    if (signal?.aborted) return error;
    if (error instanceof McpError && error.code !== ErrorCode.ConnectionClosed) return error;
    await this.drop(serverId, entry, connection);
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
  private toolsOf(serverId: number, connection: Connection): Promise<McpTool[]> {
    if (!connection.tools) {
      const listing = this.listAll(connection.client);
      connection.tools = listing;
      listing.then((tools) => {
        const entry = this.entries.get(serverId);
        if (entry?.connection !== connection) return;
        entry.toolCount = tools.length;
        this.changed(serverId);
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

  /** The server says its tools changed: list them again now, so views and the next caller see them. */
  private toolsChanged(serverId: number, entry: Entry, connection: Connection) {
    if (entry.connection !== connection) return;
    connection.tools = null;
    this.toolsOf(serverId, connection).catch((error: unknown) => logger.debug(`Listing MCP server ${serverId}'s changed tools failed: ${describe(error)}`));
  }

  private connectionClosed(serverId: number, entry: Entry, connection: Connection) {
    if (entry.connection !== connection) return;
    entry.connection = null;
    this.changed(serverId);
  }

  private async drop(serverId: number, entry: Entry, connection = entry.connection) {
    this.clearIdle(entry);
    if (!connection) return;
    if (entry.connection === connection) entry.connection = null;
    await connection.client.close().catch(() => undefined);
    this.changed(serverId);
  }

  private clearIdle(entry: Entry) {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }

  private scheduleIdle(serverId: number, entry: Entry) {
    if (entry.inFlight > 0 || !entry.connection || this.closed) return;
    this.clearIdle(entry);
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = null;
      if (entry.inFlight === 0) void this.drop(serverId, entry);
    }, this.options.idleMs);
    entry.idleTimer.unref?.();
  }
}

/** What the server's configuration alone says: disabled, or OAuth without tokens. */
function configurationBlock(server: McpServerRow): McpServerUnavailableError["status"] | null {
  if (!server.enabled) return { state: "disabled" };
  if (server.authKind === "oauth" && !mcpSecretKinds(server.id).has("tokens")) return { state: "needs_sign_in" };
  return null;
}

function describe(error: unknown): string {
  if (error instanceof StreamableHTTPError && error.code !== undefined) {
    return `The server answered HTTP ${error.code}: ${error.message.replace(/^Streamable HTTP error: (Error POSTing to endpoint: )?/, "")}`;
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

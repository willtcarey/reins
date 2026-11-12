/**
 * The MCP extension (docs/dev/mcp-servers.md): the MCP servers the user adds in Settings (remote ones, and
 * stdio ones run on a node), their connections, OAuth and `reins.mcp`. It uses only the server SDK (`@reins/sdk/server`) and its own modules.
 */

import type { Disposer, ServerExtension, ServerSdk } from "@reins/sdk/server";
import { McpConnections, type McpConnectionOptions } from "./connections.js";
import { McpRefreshLock, McpTokenRefresher, type McpTokenRefreshOptions } from "./oauth-provider.js";
import { McpStdio } from "./stdio.js";
import { McpStore } from "./store.js";
import { McpServerNotFoundError, McpServers, type McpContext } from "./servers.js";
import { CALLBACK_PATH, registerMcpRoutes } from "./routes.js";
import { mcpScripting } from "./scripting.js";
import { mcpPromptSection } from "./prompt.js";
import { mcpToolProvider } from "./tools.js";
import { mcpMigrations } from "./migrations.js";

/** How MCP's timers and timeouts are set (tests set their own). */
export type McpOptions = McpConnectionOptions & McpTokenRefreshOptions;

/** One app's MCP: the servers, over the connections it keeps until it is disposed. */
export interface Mcp {
  servers: McpServers;
  dispose: Disposer;
}

/** Starts MCP for one app: its connections (closed when it is disposed), the OAuth background refresh (stopped
 * then), routes, `reins.mcp`, tool provider and prompt section. */
export function startMcp(reins: ServerSdk, options: McpOptions = {}): Mcp {
  const store = new McpStore(reins.db, reins.secrets);
  const stdio = new McpStdio(reins.nodes, reins.sessions, store, reins.logger);
  const refreshLock = new McpRefreshLock();
  const context: McpContext = {
    store,
    connections: new McpConnections(store, reins.logger, serverId => publishChange(serverId), stdio, refreshLock, options),
    broadcast: message => reins.broadcast(message),
    callbackPath: reins.http.pagePath(CALLBACK_PATH),
    stdio,
  };
  const refresher = new McpTokenRefresher(store, refreshLock, reins.logger, serverId => publishChange(serverId), options);
  const servers = new McpServers(context);
  /** A change of a server's status without a change to it: browsers are told, unless it was removed meanwhile. */
  const publishChange = (serverId: number) => {
    let server;
    try {
      server = servers.get(serverId);
    } catch (error) {
      if (error instanceof McpServerNotFoundError) return;
      throw error;
    }
    void server.publish().catch((error: unknown) => reins.logger.warn(`Publishing MCP server ${server.name} failed:`, error));
  };
  const removals = [
    registerMcpRoutes(reins.http, servers),
    reins.scripting.register(mcpScripting(servers, context.callbackPath)),
    reins.tools.register(mcpToolProvider(servers, reins.tools, reins.name)),
    reins.prompt.register(mcpPromptSection(store, reins.name)),
  ];
  return {
    servers,
    async dispose() {
      for (const remove of removals) await remove();
      refresher.close();
      await context.connections.close();
    },
  };
}

export const mcp: ServerExtension = {
  migrations: mcpMigrations,
  register: reins => startMcp(reins).dispose,
};

/**
 * The MCP extension (docs/dev/mcp-servers.md): remote MCP servers the user adds in Settings, their
 * connections, OAuth and `api.mcp`. It uses only the server SDK (`@reins/sdk/server`) and its own modules.
 */

import type { Disposer, ServerSdk } from "@reins/sdk/server";
import { McpConnections, type McpConnectionOptions } from "./connections.js";
import { McpStore } from "./store.js";
import { McpServerNotFoundError, McpServers, type McpContext } from "./servers.js";
import { CALLBACK_PATH, registerMcpRoutes } from "./routes.js";
import { mcpScripting } from "./scripting.js";
import { mcpPromptSection } from "./prompt.js";
import { mcpToolSource } from "./tools.js";

/** One app's MCP: the servers, over the connections it keeps until it is disposed. */
export interface Mcp {
  servers: McpServers;
  dispose: Disposer;
}

/** Starts MCP for one app: its connections (closed when it is disposed), routes, `api.mcp`, tool source and
 * prompt section. */
export function startMcp(reins: ServerSdk, options: McpConnectionOptions = {}): Mcp {
  const store = new McpStore(() => reins.db, reins.secrets);
  const context: McpContext = {
    store,
    connections: new McpConnections(store, reins.logger, serverId => publishChange(serverId), options),
    broadcast: message => reins.broadcast(message),
    callbackPath: reins.routes.pagePath(CALLBACK_PATH),
  };
  const servers = new McpServers(context);
  /** A change of a server's status without a change to it: browsers are told, unless it was removed meanwhile. */
  const publishChange = (serverId: number) => {
    try {
      servers.get(serverId).publish();
    } catch (error) {
      if (!(error instanceof McpServerNotFoundError)) throw error;
    }
  };
  const removals = [
    registerMcpRoutes(reins.routes, servers),
    reins.scripting.register(mcpScripting(servers, context.callbackPath)),
    reins.tools.register(mcpToolSource(servers, reins.tools)),
    reins.prompt.register(mcpPromptSection(store)),
  ];
  return {
    servers,
    async dispose() {
      for (const remove of removals) await remove();
      await context.connections.close();
    },
  };
}

export function registerMcp(reins: ServerSdk): Disposer {
  return startMcp(reins).dispose;
}

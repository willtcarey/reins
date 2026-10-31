/**
 * The MCP extension's client: its HTTP API (`/api/extensions/mcp`, backend `extensions/mcp/routes.ts`)
 * through `@reins/client`'s extension requests, and its messages over the browser's WebSocket.
 */

import type { ExtensionClient, RequestOptions } from "@reins/client";
import type { McpMessage, McpServerInput, McpServerUpdate, McpServerView, McpSignInStart } from "@backend/extensions/mcp/servers.js";
import type { McpTool } from "@backend/extensions/mcp/connections.js";

/** The extension's name: where its API is, and whose WebSocket messages are its. */
export const MCP_EXTENSION = "mcp";

/** Remote MCP servers: their settings (secrets are written, never read back), OAuth sign-in and tools. */
export function mcpServersClient(client: ExtensionClient) {
  const path = (serverId: number) => `/servers/${client.segment(serverId)}`;
  return {
    list: (options?: RequestOptions) => client.json<McpServerView[]>("GET", "/servers", undefined, options),
    create: (input: McpServerInput, options?: RequestOptions) => client.json<McpServerView>("POST", "/servers", input, options),
    /** What is left out is kept; a secret given as null is removed. */
    update: (serverId: number, input: McpServerUpdate, options?: RequestOptions) => client.json<McpServerView>("PATCH", path(serverId), input, options),
    remove: (serverId: number, options?: RequestOptions) => client.none("DELETE", path(serverId), undefined, options),
    /** Connects afresh and lists its tools: its view, whose status says how it went. */
    test: (serverId: number, options?: RequestOptions) => client.json<McpServerView>("POST", `${path(serverId)}/test`, undefined, options),
    /** Where to send the user to sign in; the sign-in completes at the callback in that window, and an
     * `mcp_server_updated` message says so. */
    signIn: (serverId: number, options?: RequestOptions) => client.json<McpSignInStart>("POST", `${path(serverId)}/sign-in`, undefined, options),
    signOut: (serverId: number, options?: RequestOptions) => client.json<McpServerView>("POST", `${path(serverId)}/sign-out`, undefined, options),
    tools: (serverId: number, options?: RequestOptions) => client.json<McpTool[]>("GET", `${path(serverId)}/tools`, undefined, options),
  };
}

export type McpServersClient = ReturnType<typeof mcpServersClient>;

/** Whether a backend extension's message is one of this extension's (the server sends them; it is trusted
 * for their shape). */
export function isMcpMessage(extension: string, message: object): message is McpMessage {
  return extension === MCP_EXTENSION && "type" in message && (message.type === "mcp_server_updated" || message.type === "mcp_server_removed");
}

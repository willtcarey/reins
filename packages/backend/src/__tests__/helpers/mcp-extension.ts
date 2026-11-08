/**
 * The MCP extension for tests: registered as the server registers it, with the test's connection options,
 * and its servers (`McpServers`) for the test to work with, once an app registered it.
 */

import type { BuiltInBackendPart } from "../../extension-system/extensions.js";
import type { McpConnectionOptions } from "../../extensions/mcp/connections.js";
import type { McpServers } from "../../extensions/mcp/servers.js";
import type { McpMessage } from "../../extensions/mcp/servers.js";
import { mcp, startMcp } from "../../extensions/mcp/index.js";

export interface TestMcp {
  registration: BuiltInBackendPart;
  /** The servers of the app that registered it last. */
  readonly servers: McpServers;
}

export function testMcp(options: McpConnectionOptions = {}): TestMcp {
  let servers: McpServers | undefined;
  return {
    registration: {
      name: "mcp",
      migrations: mcp.migrations,
      register: reins => {
        const started = startMcp(reins, options);
        servers = started.servers;
        return started.dispose;
      },
    },
    get servers() {
      if (!servers) throw new Error("testMcp: no app registered it");
      return servers;
    },
  };
}

/** The MCP extension's message in a browser frame, or null for another frame. */
export function mcpMessage(frame: string): McpMessage | null {
  const parsed: { type: string; extension?: string; message?: McpMessage } = JSON.parse(frame);
  return parsed.type === "extension" && parsed.extension === "mcp" && parsed.message ? parsed.message : null;
}

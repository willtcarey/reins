/**
 * The MCP extension's frontend part (docs/features/mcp-servers.md): its Settings page, which lists the user's own
 * MCP servers and lets the user add, sign in to, test and remove them; and each session's list of its `.mcp.json`'s
 * servers in the Inspector (`/mcp`), where the user turns each on or off.
 */

import type { McpApi } from "@backend/extensions/mcp/api.js";
import type { Disposer, ReinsSdk } from "@reins/sdk";
import { McpServersStore } from "./mcp-servers-store.js";
import { registerMcpSessionServers } from "./session-servers.js";
import { showToast } from "../../ui/toast.js";
import "./mcp-servers-section.js";

export function registerMcp(reins: ReinsSdk<McpApi>): Disposer {
  const disposers = [
    reins.settings.register({
      mount(target) {
        const store = new McpServersStore(reins);
        const section = target.ownerDocument.createElement("settings-mcp-servers-section");
        section.store = store;
        target.append(section);
        void store.load().then((result) => {
          if ("error" in result) showToast(`Failed to load MCP servers: ${result.error}`, "error");
        });
        return {
          dispose() {
            section.remove();
            store.dispose();
          },
        };
      },
    }),
    registerMcpSessionServers(reins),
  ];
  return () => {
    for (const dispose of disposers) void dispose();
  };
}

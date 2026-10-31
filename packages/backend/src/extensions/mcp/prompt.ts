/**
 * The MCP extension's system prompt section (`reins.prompt`): the enabled servers with the user's
 * instructions for each, for sessions offered `execute` (docs/dev/mcp-servers.md *Exposing tools to agents*).
 */

import type { PromptContribution } from "@reins/sdk/server";
import type { McpStore } from "./store.js";

// Servers are named here with the user's instructions, not their tools: a server can have hundreds, and
// the agent looks up only those it needs.
/** `extension`: the extension's name, the prefix of its tools' IDs. */
export function mcpPromptSection(store: McpStore, extension: string): PromptContribution {
  return ({ tools }) => {
    if (tools && !tools.includes("execute")) return null;
    const servers = store.list().filter(server => server.enabled);
    if (servers.length === 0) return null;
    const lines = servers.map(({ name, instructions }) => {
      const text = instructions.trim();
      return text ? `- ${name}: ${text.split(/\r?\n/).join("\n  ")}` : `- ${name}`;
    });
    return "MCP servers (through execute): find their tools with api.tools.search(query), or api.tools.search(query, { server }) for one " +
      `server's; call one with api.tools.call(id, args). A tool's ID is ${extension}__<server>__<tool>. search does not list them.\n` +
      lines.join("\n");
  };
}

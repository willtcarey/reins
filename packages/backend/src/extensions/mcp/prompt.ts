/**
 * The MCP extension's system prompt section (`reins.prompt`): the session's servers that are on, with the user's
 * instructions for each, and one line naming those that are off, for sessions offered `execute` (docs/dev/mcp-servers.md
 * *Exposing tools to agents*). A session's runtime opening is when its checkout's `.mcp.json` is read (*Repo servers*).
 */

import type { Logger, PromptContribution } from "@reins/sdk/server";
import type { McpServers } from "./servers.js";
import type { McpServerModel } from "./server.js";

// Servers are named here with the user's instructions, not their tools: a server can have hundreds, and
// the agent looks up only those it needs. Those that are off are named too, whatever made them off, so that the
// agent can tell the user what would help; only the user can turn one on.
/** `extension`: the extension's name, the prefix of its tools' IDs. */
export function mcpPromptSection(servers: McpServers, extension: string, logger: Logger): PromptContribution {
  return async ({ session, tools }) => {
    if (tools && !tools.includes("execute")) return null;
    if (session.projectId !== null) {
      await servers.context.repo.read(session.id).catch((error: unknown) => logger.warn(`Reading session ${session.id}'s .mcp.json failed:`, error));
    }
    const all = await servers.forSession(session.id);
    if (all.length === 0) return null;
    const on = await Promise.all(all.map(server => isOn(server, session.id, servers)));
    const shown = all.filter((_, at) => on[at]);
    const off = all.filter((_, at) => !on[at]);
    const lines = shown.map(server => {
      const text = server.row.projectId === null ? server.row.instructions.trim() : "from this project's .mcp.json.";
      return text ? `- ${server.name}: ${text.split(/\r?\n/).join("\n  ")}` : `- ${server.name}`;
    });
    const header = shown.length
      ? "MCP servers (through execute): find their tools with reins.tools.search(query), or reins.tools.search(query, { filters: { server } }) for one " +
        `server's; call one with reins.tools.call(id, args). A tool's ID is ${extension}__<server>__<tool>. search does not list them.`
      : "MCP servers: none is enabled.";
    return [header, ...lines, ...offLines(off)].join("\n");
  };
}

async function isOn(server: McpServerModel, sessionId: string, servers: McpServers): Promise<boolean> {
  if (!server.row.enabled) return false;
  return server.row.projectId === null || !(await servers.context.gate.block(server.row, sessionId));
}

function offLines(off: McpServerModel[]): string[] {
  if (off.length === 0) return [];
  return [
    "Disabled (you can ask the user to turn these on with /mcp):",
    ...off.map(server => `- ${server.name}`),
  ];
}

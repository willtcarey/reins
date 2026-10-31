/**
 * The MCP servers' tools as one tool source (`reins.tools`, docs/dev/mcp-servers.md *Exposing tools to
 * agents*). A tool's ID is `<server>__<tool>`: a server's name cannot hold `__`, so the server is found from
 * the store without a connection, and an ID of no server is not this source's. The filter `{ server }`
 * limits a search to one server; other keys are not this source's, and are left alone.
 */

import { createHash } from "crypto";
import type { Tool, ToolSource, Tools } from "@reins/sdk/server";
import { McpServerNotFoundError, type McpServers } from "./servers.js";
import type { McpServerModel } from "./server.js";
import type { McpTool } from "./connections.js";

/** A model's tool names: what an ID must also be. */
const MAX_ID_LENGTH = 64;
const SEPARATOR = "__";

/** The IDs of a server's tools, by tool name: `<server>__<tool>`, the characters outside `[a-zA-Z0-9_-]`
 * made `_`. An ID too long, or that two tools would share, is cut and ends with a hash of the tool's
 * name, so that it stays the same while the server's tools do. */
export function mcpToolIds(server: string, tools: readonly McpTool[]): Map<string, string> {
  const base = (name: string) => `${server}${SEPARATOR}${name.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  const counts = new Map<string, number>();
  for (const tool of tools) counts.set(base(tool.name), (counts.get(base(tool.name)) ?? 0) + 1);
  return new Map(tools.map(tool => {
    const id = base(tool.name);
    if (id.length <= MAX_ID_LENGTH && counts.get(id) === 1) return [tool.name, id];
    const hash = createHash("sha256").update(tool.name).digest("hex").slice(0, 8);
    return [tool.name, `${id.slice(0, MAX_ID_LENGTH - hash.length - 1)}_${hash}`];
  }));
}

function asTools(server: string, tools: readonly McpTool[]): Tool[] {
  const ids = mcpToolIds(server, tools);
  return tools.map(tool => ({
    id: ids.get(tool.name)!,
    name: tool.name,
    ...(tool.title ? { title: tool.title } : {}),
    ...(tool.description ? { description: tool.description } : {}),
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
    ...(tool.annotations ? { annotations: tool.annotations } : {}),
  }));
}

const describe = (error: unknown) => error instanceof Error ? error.message : String(error);

export function mcpToolSource(servers: McpServers, tools: Pick<Tools, "match">): ToolSource {
  /** A server's tools that match, connecting to it if needed. */
  const search = async (server: string, query: string, signal: AbortSignal) => {
    const model = servers.find(server);
    return tools.match(query, asTools(model.name, await model.listTools({ signal })));
  };

  const serverNamed = (name: string): McpServerModel | null => {
    try {
      return servers.find(name);
    } catch (error) {
      if (error instanceof McpServerNotFoundError) return null;
      throw error;
    }
  };

  return {
    title: "MCP servers",

    async search(query, { filters, signal }) {
      if (typeof filters.server === "string") return search(filters.server, query, signal);
      const enabled = servers.list().filter(server => server.enabled);
      const results = await Promise.allSettled(enabled.map(server => search(server.name, query, signal)));
      const found = results.flatMap(result => result.status === "fulfilled" ? result.value : []);
      const failures = results.flatMap(result => result.status === "rejected" ? [describe(result.reason)] : []);
      // A search that found nothing could have found it on a server that failed: say which.
      if (found.length === 0 && failures.length > 0) {
        throw new Error(`No tool matches; these servers could not be searched: ${failures.join("; ")}`);
      }
      return tools.match(query, found);
    },

    async call(id, args, { signal, timeoutMs }) {
      const at = id.indexOf(SEPARATOR);
      if (at <= 0) return null;
      const model = serverNamed(id.slice(0, at));
      if (!model) return null;
      const listed = await model.listTools({ signal });
      const name = [...mcpToolIds(model.name, listed)].find(([, toolId]) => toolId === id)?.[0];
      if (name === undefined) throw new Error(`Unknown tool ${id}: ${model.name} has no such tool. Find its tools with api.tools.search(query, { server: ${JSON.stringify(model.name)} }).`);
      return model.callTool(name, args, { signal, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
    },
  };
}

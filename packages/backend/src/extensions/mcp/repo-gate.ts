/**
 * Whether a repo server may run (docs/dev/mcp-servers.md *Allowed commands*, ADR-040): the one place that decides it.
 * A repo server runs when its switch is on and, for a stdio server, when the exact command the session read
 * (`stdioVersion`: command, args, cwd, env names) is one the user allowed for its project. The allowed commands are
 * kept in the host's secret storage (encrypted and authenticated with the server's key), under
 * `allowed/<project>/<name>/<hash>`, so a row written into a database file allows nothing. None is ever taken out:
 * turning the server off stops every command of it.
 *
 * Two faces, so that what agents can reach cannot allow anything: `McpRepoGate` answers, and is what connections,
 * the prompt, tools and the list hold; `McpRepoSwitch` turns a server on or off, and only the routes hold it, for
 * requests from a browser (`HttpCall.browser`).
 */

import type { SecretStorage } from "@reins/sdk/server";
import type { McpConnections, McpServerBlock } from "./connections.js";
import { stdioVersion, versionHash, type RepoStdioEntry, type StdioVersion } from "./repo-config.js";
import { InvalidMcpServerError } from "./input.js";
import type { McpServerRow, McpStore } from "./store.js";

/** A command the user allowed for a project's server name. */
interface AllowedCommand extends StdioVersion {
  serverName: string;
  hash: string;
  allowedAt: string;
}

const allowedPrefix = (projectId: number, serverName: string) => `allowed/${projectId}/${serverName}/`;

/** What an agent is told of a repo server that may not run. */
const off = (name: string): McpServerBlock => ({
  state: "off",
  message: `MCP server ${name} (from this project's .mcp.json) is disabled: only the user can turn it on, with /mcp.`,
});

export interface McpRepoGateDependencies {
  store: McpStore;
  secrets: SecretStorage;
}

/** Answers whether a repo server may run. Nothing here allows anything. */
export class McpRepoGate<D extends McpRepoGateDependencies = McpRepoGateDependencies> {
  constructor(protected readonly deps: D) {}

  /**
   * Why `row` may not run in the session (null: it may): `off` when its switch is off or the command the session read
   * is not allowed. Without a session, the command as last read anywhere. Null for the user's own servers, whose
   * switch is their connection's to check.
   */
  async block(row: McpServerRow, sessionId: string | null): Promise<McpServerBlock | null> {
    if (row.projectId === null) return null;
    if (!row.enabled) return off(row.name);
    if (row.transport !== "stdio") return null;
    const entry = this.deps.store.repoEntry(row, sessionId);
    if (entry?.kind !== "stdio") return { state: "error", message: `${row.name} is not a stdio server in this session's .mcp.json` };
    return await this.isAllowed(row.projectId, entry) ? null : off(row.name);
  }

  /** Another command of the server is allowed, not `entry`'s: the file changed it since the user turned it on. */
  async changed(projectId: number, entry: RepoStdioEntry): Promise<boolean> {
    if (await this.isAllowed(projectId, entry)) return false;
    return (await this.deps.secrets.keys(allowedPrefix(projectId, entry.name))).length > 0;
  }

  protected async isAllowed(projectId: number, entry: RepoStdioEntry): Promise<boolean> {
    return (await this.deps.secrets.get(allowedPrefix(projectId, entry.name) + versionHash(stdioVersion(entry)))) !== undefined;
  }
}

export interface McpRepoSwitchDependencies extends McpRepoGateDependencies {
  connections: Pick<McpConnections, "disconnect">;
  /** Browsers are told that a project's repo servers changed. */
  changed(projectId: number): void;
  now?(): Date;
}

/**
 * The user's toggle of a repo server, from a session's MCP servers list. Only the routes hold this, and they give it
 * only requests from a browser: no script, tool, `reins.mcp` method or extension API reaches it (ADR-040). It is
 * idempotent, so two browsers answering at once agree.
 */
export class McpRepoSwitch extends McpRepoGate<McpRepoSwitchDependencies> {
  /**
   * On: its switch on and, for a stdio server, the command the session read allowed for the project. Off: its switch
   * off, so nothing of it runs for the project; the commands allowed stay allowed. A change of the switch closes its
   * connections.
   */
  async set(row: McpServerRow, on: boolean, sessionId: string): Promise<void> {
    if (row.projectId === null) throw new InvalidMcpServerError(`MCP server ${row.name} is not a project's`);
    const entry = this.deps.store.repoEntry(row, sessionId);
    if (on && !entry) throw new InvalidMcpServerError(`${row.name} is not in this session's .mcp.json`);
    if (on && entry?.kind === "stdio") await this.allow(row.projectId, entry);
    if (row.enabled !== on) {
      this.deps.store.setEnabled(row.id, on);
      await this.deps.connections.disconnect(row.id);
    }
    this.deps.changed(row.projectId);
  }

  private async allow(projectId: number, entry: RepoStdioEntry): Promise<void> {
    if (await this.isAllowed(projectId, entry)) return;
    const version = stdioVersion(entry);
    const hash = versionHash(version);
    const allowed: AllowedCommand = { ...version, serverName: entry.name, hash, allowedAt: (this.deps.now?.() ?? new Date()).toISOString() };
    await this.deps.secrets.set(allowedPrefix(projectId, entry.name) + hash, JSON.stringify(allowed));
  }
}

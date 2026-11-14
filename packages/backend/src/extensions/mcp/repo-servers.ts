/**
 * Repo servers (docs/dev/mcp-servers.md *Repo servers*): the MCP servers a project's `.mcp.json` defines, read from
 * the session's own checkout, through its node, each time its runtime opens. Each entry is a row of its project and
 * name (`McpStore.upsertRepo`), which holds what is the user's (the switch, the sign-in, the values of its
 * variables) and the entry as last read; what each session read is kept for it (`McpStore.repoRead`), so a session
 * runs the stdio version of its own branch. What a session's MCP servers list shows is `sessionView`.
 */

import { posix } from "node:path";
import type { Logger, Nodes, Sessions } from "@reins/sdk/server";
import type { McpConnections, McpServerStatus } from "./connections.js";
import type { McpRepoGate } from "./repo-gate.js";
import { mcpSignedIn } from "./oauth-provider.js";
import {
  parseRepoConfig, REPO_CONFIG_FILE, stdioVersion, templateVariables,
  type RepoEntry, type RepoFile, type RepoSkipped, type StdioVersion,
} from "./repo-config.js";
import type { McpAuthKind, McpRepoRead, McpSecretKind, McpServerRow, McpStore } from "./store.js";

/** What a sign-in is of: a change to any of these in the file signs the user out. */
const OAUTH_SECRETS: readonly McpSecretKind[] = ["client_information", "tokens", "code_verifier", "discovery"];

interface RepoServerCommon {
  id: number;
  projectId: number;
  name: string;
  enabled: boolean;
  /** Its toggle: it may run, so its switch is on and, for a stdio server, the command the session read is allowed. */
  allowed: boolean;
  status: McpServerStatus;
  /** The variables its header or env values name (`${VAR}`), and whether the user gave a value for each. */
  variables: Array<{ name: string; set: boolean }>;
}

export interface McpRepoHttpServerView extends RepoServerCommon {
  transport: "http" | "sse";
  url: string;
  /** The row's, as the settings page badges it: a repo HTTP server's is `oauth` (it signs in when the server asks). */
  authKind: McpAuthKind;
  headerNames: string[];
  signedIn: boolean;
}

export interface McpRepoStdioServerView extends RepoServerCommon {
  transport: "stdio";
  /** Its command as the session read it, exactly as it would run. */
  version: StdioVersion;
  /** Another command of it is allowed, not this one: the file changed it since the user turned it on. */
  changed: boolean;
}

export type McpRepoServerView = McpRepoHttpServerView | McpRepoStdioServerView;

/** A session's MCP servers list: its project, its `.mcp.json` as it read it (when), its servers and the entries skipped. */
export interface McpSessionServersView {
  projectId: number;
  file: { state: RepoFile["state"]; error: string | null; sessionId: string; readAt: string } | null;
  servers: McpRepoServerView[];
  skipped: RepoSkipped[];
}

export interface McpRepoDependencies {
  store: McpStore;
  connections: McpConnections;
  gate: McpRepoGate;
  sessions: Pick<Sessions, "get">;
  nodes: Pick<Nodes, "readFile">;
  /** Browsers are told that a project's repo servers changed. */
  changed(projectId: number): void;
  logger: Logger;
}

/** The user's values for a repo server's variables, by name. */
export async function repoVariables(store: McpStore, serverId: number): Promise<Record<string, string>> {
  const stored = await store.getSecret(serverId, "variables");
  const values: Record<string, string> = stored ? JSON.parse(stored) : {};
  return values;
}

const describe = (error: unknown) => error instanceof Error ? error.message : String(error);
/** Why an entry with the name of one of the user's own servers is skipped: a repository must not stand in for a
 * server the user trusts by its name (its tools, their instructions). Checked at each use, so that adding or removing
 * one of their own servers takes effect at once. */
const OWN_NAME = "one of your own MCP servers (Settings → MCP) has this name, and a project's server does not replace it";
/** How an HTTP entry is reached and signed in to: a change to it signs the user out. */
const reached = (entry: RepoEntry | null) => entry?.kind === "http" ? JSON.stringify([entry.transport, entry.url, entry.headers]) : null;

export class McpRepoServers {
  constructor(private readonly deps: McpRepoDependencies) {}

  private get store(): McpStore { return this.deps.store; }

  /**
   * Reads the session's checkout's `.mcp.json` now, as its runtime opens: keeps what it says for the session and its
   * project's rows. A changed URL, transport or headers signs the user out of that HTTP server; a stdio entry that
   * changed in this session stops the session's process of it. Null for a session of no project.
   */
  async read(sessionId: string): Promise<McpRepoRead | null> {
    const session = await this.deps.sessions.get(sessionId);
    if (session.projectId === null) return null;
    const file = await this.readFile(session.source.nodeId, session.source.path);
    const before = this.store.repoRead(sessionId);
    // A node that cannot read it now (away, refusing) leaves the session with what it read last.
    if (file === null) return before;
    this.store.setRepoRead(sessionId, session.projectId, file);
    // A session that never read one and finds none changes nothing a browser shows.
    let changed = (before !== null && before.projectId !== session.projectId) || JSON.stringify(before?.file ?? { state: "missing" }) !== JSON.stringify(file);
    if (file.state === "read") {
      for (const entry of file.entries) {
        const previous = before?.projectId === session.projectId && before.file.state === "read" ? before.file.entries.find(candidate => candidate.name === entry.name) : undefined;
        if (await this.adopt(session.projectId, sessionId, entry, previous)) changed = true;
      }
    }
    // Every runtime open reads it: browsers hear only of a change.
    if (changed) this.deps.changed(session.projectId);
    return this.store.repoRead(sessionId);
  }

  /** What the session read last; read now when it never did. */
  async ofSession(sessionId: string): Promise<McpRepoRead | null> {
    return this.store.repoRead(sessionId) ?? this.read(sessionId);
  }

  /** The rows of the servers the session's file has, in name order. A session that cannot be read (gone) has none:
   * the user's own servers still answer. */
  async sessionServers(sessionId: string): Promise<McpServerRow[]> {
    let read: McpRepoRead | null;
    try {
      read = await this.ofSession(sessionId);
    } catch (error) {
      this.deps.logger.warn(`Finding session ${sessionId}'s repo MCP servers failed: ${describe(error)}`);
      return [];
    }
    if (read?.file.state !== "read") return [];
    const own = this.ownNames();
    return read.file.entries.flatMap(entry => own.has(entry.name) ? [] : this.store.projectServer(read.projectId, entry.name) ?? []);
  }

  /** Sets (or with null removes) the user's values for the server's variables, then reconnects it. */
  async setVariables(server: McpServerRow, values: Record<string, string | null>): Promise<void> {
    if (server.projectId === null) throw new Error(`MCP server ${server.name} is not a project's`);
    const stored = await repoVariables(this.store, server.id);
    for (const [name, value] of Object.entries(values)) {
      if (value === null) delete stored[name];
      else stored[name] = value;
    }
    await this.store.setSecret(server.id, "variables", Object.keys(stored).length ? JSON.stringify(stored) : null);
    await this.deps.connections.disconnect(server.id);
    this.deps.changed(server.projectId);
  }

  /** A session's MCP servers list: the servers of its own read, each as its checkout has it. Null for a session of no
   * project. */
  async sessionView(sessionId: string): Promise<McpSessionServersView | null> {
    const read = await this.ofSession(sessionId);
    if (!read) return null;
    const own = this.ownNames();
    const entries = read.file.state === "read" ? read.file.entries : [];
    const servers = await Promise.all(entries.flatMap(entry => {
      const row = own.has(entry.name) ? null : this.store.projectServer(read.projectId, entry.name);
      return row ? [this.serverView(row, entry, sessionId)] : [];
    }));
    const replacing = entries.filter(entry => own.has(entry.name)).map(entry => ({ name: entry.name, reason: OWN_NAME }));
    const view = this.fileView(read);
    return { projectId: read.projectId, ...view, skipped: [...replacing, ...view.skipped], servers };
  }

  private ownNames(): Set<string> {
    return new Set(this.store.list().map(row => row.name));
  }

  private fileView(read: McpRepoRead | null): Pick<McpSessionServersView, "file" | "skipped"> {
    return {
      file: read ? { state: read.file.state, error: read.file.state === "invalid" ? read.file.error : null, sessionId: read.sessionId, readAt: read.readAt } : null,
      skipped: read?.file.state === "read" ? read.file.skipped : [],
    };
  }

  /** A server as the session's checkout has it: whether it may run there is the gate's, as for agents. */
  private async serverView(row: McpServerRow, entry: RepoEntry, sessionId: string): Promise<McpRepoServerView> {
    const given = await repoVariables(this.store, row.id);
    const blocked = await this.deps.gate.block(row, sessionId);
    const common = {
      id: row.id, projectId: row.projectId!, name: row.name, enabled: row.enabled, allowed: blocked?.state !== "off",
      variables: templateVariables(entry).map(name => ({ name, set: Object.hasOwn(given, name) })),
    };
    if (entry.kind === "stdio") {
      const status = blocked ?? this.deps.connections.status(row, false);
      return { ...common, transport: "stdio", status, version: stdioVersion(entry), changed: await this.deps.gate.changed(row.projectId!, entry) };
    }
    const signedIn = await mcpSignedIn(this.store, row.id);
    return {
      ...common, transport: entry.transport, url: entry.url, authKind: row.transport === "stdio" ? "none" : row.authKind, headerNames: Object.keys(entry.headers),
      signedIn, status: blocked ?? this.deps.connections.status(row, signedIn),
    };
  }


  /** The file as its node reads it; null when the node cannot read it now (not a missing file). */
  private async readFile(nodeId: string, checkout: string): Promise<RepoFile | null> {
    let text: string;
    try {
      const content = await this.deps.nodes.readFile(nodeId, posix.join(checkout, REPO_CONFIG_FILE));
      text = typeof content === "string" ? content : new TextDecoder().decode(content);
    } catch (error) {
      if (/ENOENT|no such file/i.test(describe(error))) return parseRepoConfig(null);
      this.deps.logger.debug(`Reading ${REPO_CONFIG_FILE} in ${checkout} on node ${nodeId} failed: ${describe(error)}`);
      return null;
    }
    return parseRepoConfig(text);
  }

  /** The project's row says what this read: a change to how an HTTP server is reached signs the user out of it; a
   * stdio entry changed in this session restarts it there. */
  private async adopt(projectId: number, sessionId: string, entry: RepoEntry, previous: RepoEntry | undefined): Promise<boolean> {
    const { row, before } = this.store.upsertRepo(projectId, entry);
    if (!before) return true;
    const was = before.repo;
    if (entry.kind === "http" && reached(was) !== reached(entry)) {
      await this.store.deleteSecrets(row.id, OAUTH_SECRETS);
      await this.store.endSignIn(row.id);
      await this.deps.connections.disconnect(row.id);
    } else if (was?.kind !== entry.kind) {
      await this.deps.connections.disconnect(row.id);
    } else if (entry.kind === "stdio" && previous && JSON.stringify(previous) !== JSON.stringify(entry)) {
      await this.deps.connections.disconnectSession(row.id, sessionId);
    }
    return JSON.stringify(was) !== JSON.stringify(entry);
  }
}

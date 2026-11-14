/**
 * Stdio servers' processes (docs/dev/mcp-servers.md *Stdio servers*): one for each server and calling session, on
 * the session's node, in its checkout, kept under `mcp:<server>:<session>`, and the processes an earlier app left
 * (`McpStdio`); and the MCP SDK `Transport` over one (`NodeProcessTransport`), newline-delimited JSON-RPC on its stdin
 * and stdout. Connecting, sharing and idle closing are `McpConnections`'.
 */

import { posix } from "node:path";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { JSONRPCMessageSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Logger, NodeProcess, NodeProcessExit, Nodes, Sessions } from "@reins/sdk/server";
import type { McpStdioRow, McpStore } from "./store.js";
import { expandTemplate, type RepoStdioEntry } from "./repo-config.js";
import { repoVariables } from "./repo-servers.js";

/** What stdio servers need of the nodes (`reins.nodes`). */
export type McpNodes = Pick<Nodes, "spawn" | "processes" | "stop" | "run">;

const KEY_PREFIX = "mcp:";
/** The key the server's process for a session is kept under on the session's node. A repo server's has its project's
 * ID before its name (`mcp:<project>/<name>:<session>`): a name starts with a letter, so the two never meet. */
const processKey = (server: { name: string; projectId: number | null }, sessionId: string) =>
  `${KEY_PREFIX}${server.projectId === null ? "" : `${server.projectId}/`}${server.name}:${sessionId}`;

/** A stdio server runs in the calling session's checkout: a call with no session has none. */
export class McpServerSessionRequiredError extends Error {
  constructor(readonly serverName: string) {
    super(`MCP server ${serverName} runs in the calling session's checkout, and this call has no session`);
    this.name = "McpServerSessionRequiredError";
  }
}

/** Where a server's process starts: the session's checkout, or `cwd` inside it when relative. */
export function processCwd(checkout: string, cwd: string | null): string {
  if (!cwd) return checkout;
  return cwd.startsWith("/") || cwd === "~" || cwd.startsWith("~/") ? cwd : posix.join(checkout, cwd);
}

/** Stdio servers' processes on the nodes, for one app. Reattaching after a reload is not done yet: an earlier app's
 * processes are stopped when it starts, and each start replaces what its key held. */
export class McpStdio {
  /** Starts wait for the processes an earlier app left to be stopped. */
  private readonly leftoversStopped: Promise<void>;

  constructor(
    private readonly nodes: McpNodes,
    private readonly sessions: Pick<Sessions, "get">,
    private readonly store: McpStore,
    private readonly logger: Logger,
  ) {
    this.leftoversStopped = this.stopLeftovers();
  }

  /** Starts the server's process for the session: on its node, in its checkout (`processCwd`), with the server's
   * environment, under its key (replacing what was kept there). A repo server runs the version its session read
   * (which `McpRepoGate.block` checked), its env's `${VAR}`s expanded from the user's values, else the node's environment.
   * Rejects as `reins.nodes.spawn` does: an unknown program or directory, the node away; and for a variable with no
   * value. */
  async start(server: McpStdioRow, sessionId: string): Promise<NodeProcess> {
    await this.leftoversStopped;
    const { source } = await this.sessions.get(sessionId);
    const entry = this.entryFor(server, sessionId);
    if (server.projectId !== null && !entry) throw new Error(`${server.name} is not a stdio server in this session's .mcp.json`);
    const run = entry ?? { command: server.command, args: server.args, cwd: server.cwd };
    const env = entry ? await this.repoEnv(server, entry, source.nodeId) : await this.ownEnv(server);
    return this.nodes.spawn(source.nodeId, [run.command, ...run.args], {
      key: processKey(server, sessionId), env, cwd: processCwd(source.path, run.cwd),
    });
  }

  /** A repo server's stdio entry as the session read it. */
  private entryFor(server: McpStdioRow, sessionId: string): RepoStdioEntry | null {
    const entry = this.store.repoEntry(server, sessionId);
    return entry?.kind === "stdio" ? entry : null;
  }

  private async ownEnv(server: McpStdioRow): Promise<Record<string, string>> {
    const stored = await this.store.getSecret(server.id, "env");
    const env: Record<string, string> = stored ? JSON.parse(stored) : {};
    return env;
  }

  private async repoEnv(server: McpStdioRow, entry: RepoStdioEntry, nodeId: string): Promise<Record<string, string>> {
    const given = await repoVariables(this.store, server.id);
    const wanted = Object.values(entry.env).flatMap(value => expandTemplate(value, name => given[name]).missing);
    const fromNode = wanted.length ? await this.nodeEnvironment(nodeId, [...new Set(wanted)]) : {};
    const env: Record<string, string> = {};
    const missing = new Set<string>();
    for (const [name, template] of Object.entries(entry.env)) {
      const expanded = expandTemplate(template, variable => given[variable] ?? fromNode[variable]);
      for (const variable of expanded.missing) missing.add(variable);
      env[name] = expanded.value;
    }
    if (missing.size > 0) {
      throw new Error(`Its env needs a value for ${[...missing].join(", ")}: give it in the session's MCP servers list (/mcp), or set it in the node's environment`);
    }
    return env;
  }

  /** The node's values of these variables (names checked by `expandTemplate`'s pattern), for those it has. */
  private async nodeEnvironment(nodeId: string, names: string[]): Promise<Record<string, string>> {
    // Base64, so that a value of any bytes and lines comes back as it is (the output is read as text).
    const script = `for n in ${names.join(" ")}; do if [ -n "\${!n+x}" ]; then printf '%s=%s\\n' "$n" "$(printf '%s' "\${!n}" | base64 | tr -d '\\n')"; fi; done`;
    const { exitCode, output } = await this.nodes.run(nodeId, script, { timeoutMs: 15_000 });
    if (exitCode !== 0) throw new Error(`Reading the node's environment failed: ${output.trim()}`);
    return Object.fromEntries(output.split("\n").filter(line => line.includes("=")).map(line => {
      const at = line.indexOf("=");
      return [line.slice(0, at), Buffer.from(line.slice(at + 1), "base64").toString("utf8")];
    }));
  }

  /** Stops what is kept under the server's keys on every node, and forgets them: its removal, or its renaming (the
   * keys have its name). The processes of its connections are stopped by closing those; this also reaches what no
   * handle has. */
  async forget(serverName: string): Promise<void> {
    const prefix = processKey({ name: serverName, projectId: null }, "");
    try {
      const kept = (await this.nodes.processes()).filter(process => process.key.startsWith(prefix));
      await Promise.all(kept.map(process => this.nodes.stop(process.nodeId, process.key)));
    } catch (error) {
      this.logger.warn(`Stopping MCP server ${serverName}'s processes failed: ${describe(error)}`);
    }
  }

  /** Those an earlier app let go of (not `running` in this one) are stopped, so that a server nobody uses again
   * does not run on. */
  private async stopLeftovers(): Promise<void> {
    try {
      const kept = (await this.nodes.processes()).filter(process => process.key.startsWith(KEY_PREFIX) && process.state !== "running");
      await Promise.all(kept.map(process => this.nodes.stop(process.nodeId, process.key).catch((error: unknown) => {
        this.logger.warn(`Stopping ${process.key} on node ${process.nodeId} failed: ${describe(error)}`);
      })));
    } catch (error) {
      this.logger.warn(`Looking for MCP servers' processes to stop failed: ${describe(error)}`);
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The MCP SDK `Transport` over a stdio server's process, which starts with the transport and is stopped when it
 * closes. Its end, or a line on its stdout that is not JSON-RPC, closes the transport with the reason
 * (`endReason`), which carries the end of its stderr. */
/** How much of its stderr's end a failure quotes: enough for a stack trace's top or a "command not found". */
const STDERR_QUOTE_CHARS = 2000;

export class NodeProcessTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  /** Why it closed when it was not closed by its client: set before `onclose`. */
  endReason: string | null = null;
  /** The node it runs on, once started. */
  get nodeId(): string | null { return this.process?.nodeId ?? null; }
  private process: NodeProcess | null = null;
  private closing = false;

  constructor(private readonly spawn: () => Promise<NodeProcess>) {}

  async start(): Promise<void> {
    if (this.process) throw new Error("The stdio transport is started already");
    const process = await this.spawn();
    this.process = process;
    void this.read(process);
    void process.exited.then(exit => this.ended(process, exit));
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.process) throw new Error("The stdio transport is not started");
    await this.process.write(`${JSON.stringify(message)}\n`);
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.process?.stop();
  }

  private async read(process: NodeProcess): Promise<void> {
    try {
      for await (const line of process.lines) {
        if (!line.trim()) continue;
        let message: JSONRPCMessage;
        try {
          message = JSONRPCMessageSchema.parse(JSON.parse(line));
        } catch {
          // Its stdout is the protocol's: anything else there means the stream can no longer be trusted.
          this.endReason ??= `It wrote a line that is not JSON-RPC to its stdout: ${line.slice(0, 200)}`;
          void process.stop();
          return;
        }
        this.onmessage?.(message);
      }
    } catch (error) {
      // A line too long: the process is stopped, and its exit says the rest.
      this.endReason ??= error instanceof Error ? error.message : String(error);
    }
  }

  private ended(process: NodeProcess, exit: NodeProcessExit): void {
    if (!this.closing) {
      this.endReason ??= describeExit(exit);
      const stderr = process.stderrTail().trim();
      if (stderr) this.endReason += `. Its stderr ended:\n${stderr.slice(-STDERR_QUOTE_CHARS)}`;
      this.onerror?.(new Error(this.endReason));
    }
    this.onclose?.();
  }
}

function describeExit(exit: NodeProcessExit): string {
  if (exit.error) return `The process ended: ${exit.error}`;
  if (exit.detached) return "The process was let go";
  if (exit.signal) return `The process was ended by ${exit.signal}`;
  return `The process exited with code ${exit.code}`;
}

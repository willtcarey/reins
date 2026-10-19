/**
 * A node's machine as a whole (`NodeHost`, from `NodeModel.host`): its files and commands anywhere on it,
 * not in a checkout, for scripts (`api.nodes.readFile`, `writeFile`, `run`). Built on the operations under
 * the agent's tools (`RemoteExecutionEnv`: `fs.*` and `pi.exec`, with Pi's semantics), so no protocol of
 * its own.
 */
import { applyShellOutputUpdate, BACKGROUND_CONTEXT, withAbortSignal, type Context, type ShellOutputView } from "@earendil-works/pi-agent-core";
import { RemoteExecutionEnv } from "../sessions/remote-env.js";
import type { NodeHub, RemoteNode } from "../state.js";

/** The most bytes one file read or one command's output holds in the server's memory. */
export const MAX_NODE_HOST_BYTES = 16 * 1024 * 1024;

/** The output a command's stream carries as it runs (its view): the protocol's bound on it
 * (`MAX_EXEC_VIEW_BYTES`, which the protocol package does not export). Output beyond it is read from the file Pi spills it to. */
const OUTPUT_VIEW_BYTES = 1024 * 1024;

/** The node is not connected now (or its link dropped mid-call): calls for it fail at once, they do not
 * wait for it. */
export class NodeUnavailableError extends Error {
  constructor(node: { id: string; name: string }) {
    super(`Node unavailable: "${node.name}" (${node.id}) is not connected`);
    this.name = "NodeUnavailableError";
  }
}

/** What a command run on a node gave: its exit code and its output (stdout and stderr together), the first
 * `MAX_NODE_HOST_BYTES` of it, `truncated` when there was more. */
export interface NodeRunResult { exitCode: number; output: string; truncated: boolean }

/** Control characters Pi leaves out of a command's output view (its `sanitizeShellOutput`, not exported):
 * left out of output read from its spill file too, so the output reads the same whatever its size. */
const INVALID_SHELL_OUTPUT = /[\x00-\x08\x0b-\x1f\ufff9-\ufffb]/g; // eslint-disable-line no-control-regex -- control characters are what it removes
const quoted = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

/**
 * One node's files and commands, anywhere on its machine. Relative paths, and commands, start in the node's
 * home; `~` is it. Nothing is confined: the server can already run anything on a node. Unlike a session's
 * tools, nothing waits for the node: one not connected, or whose link drops mid-call, fails the call with
 * `NodeUnavailableError`. What a call returns is held in the server's memory, so it is bounded
 * (`MAX_NODE_HOST_BYTES`).
 */
export class NodeHost {
  constructor(private readonly hub: NodeHub, private readonly node: { id: string; name: string }) {}

  /** The whole file's bytes. Throws for a file larger than `MAX_NODE_HOST_BYTES`, and with the node's
   * answer for one it cannot read (missing, a directory, …). */
  async readFile(path: string, { signal }: { signal?: AbortSignal } = {}): Promise<Uint8Array> {
    const context = contextOf(signal);
    const read = await (await this.env(context)).readFileHead(path, MAX_NODE_HOST_BYTES, context);
    if (!read.ok) throw new Error(`Cannot read ${path} on "${this.node.name}": ${read.error.message}`);
    if (read.value.size > MAX_NODE_HOST_BYTES) throw new Error(`Cannot read ${path} on "${this.node.name}": it has ${read.value.size} bytes, more than the ${MAX_NODE_HOST_BYTES} a read may hold`);
    return read.value.bytes;
  }

  /** Writes the file whole (UTF-8 for text), as Pi's write tool does: its directories created, a file
   * there replaced. */
  async writeFile(path: string, content: string | Uint8Array, { signal }: { signal?: AbortSignal } = {}): Promise<void> {
    const context = contextOf(signal);
    const written = await (await this.env(context)).writeFile(path, content, context);
    if (!written.ok) throw new Error(`Cannot write ${path} on "${this.node.name}": ${written.error.message}`);
  }

  /**
   * Runs `command` with bash as the agent's bash tool runs it (`pi.exec`), in `cwd` (the node's home by
   * default), killed after `timeoutMs`. Its output beyond the view a command's stream carries
   * (`OUTPUT_VIEW_BYTES`) is read from the spill file Pi keeps on the node, which is then removed.
   * Throws when it times out, is aborted or cannot be run (`cwd` missing, its outcome unknown).
   */
  async run(command: string, { cwd, timeoutMs, signal }: { cwd?: string; timeoutMs: number; signal?: AbortSignal }): Promise<NodeRunResult> {
    const context = contextOf(signal);
    const env = await this.env(context);
    let view: ShellOutputView | undefined;
    const result = await env.exec(command, {
      ...(cwd === undefined ? {} : { cwd }),
      timeout: timeoutMs / 1000,
      capture: { limits: { maxBytes: OUTPUT_VIEW_BYTES, maxLines: Number.MAX_SAFE_INTEGER, retain: "head" }, spill: true },
      onUpdate: update => { view = applyShellOutputUpdate(view, update); },
    }, context);
    const spillPath = result.ok ? result.value.spillPath : view?.spillPath;
    try {
      if (!result.ok) {
        if (result.error.code === "timeout") throw new Error(`Command timed out after ${timeoutMs} ms on "${this.node.name}"`);
        if (result.error.code === "aborted") throw signal?.reason ?? new Error("Command aborted");
        throw new Error(`Command failed on "${this.node.name}": ${result.error.message}`);
      }
      if (!result.value.truncation.truncated) return { exitCode: result.value.exitCode, output: view?.text ?? "", truncated: false };
      if (!spillPath) throw new Error(`Command on "${this.node.name}": its output was not kept beyond ${OUTPUT_VIEW_BYTES} bytes`);
      const spilled = await env.readFileHead(spillPath, MAX_NODE_HOST_BYTES, context);
      if (!spilled.ok) throw new Error(`Command on "${this.node.name}": cannot read its output (${spilled.error.message})`);
      const output = Buffer.from(spilled.value.bytes).toString("utf8").replace(INVALID_SHELL_OUTPUT, "");
      return { exitCode: result.value.exitCode, output, truncated: spilled.value.size > MAX_NODE_HOST_BYTES };
    } finally {
      if (spillPath) await env.exec(`rm -f -- ${quoted(spillPath)}`, undefined, BACKGROUND_CONTEXT);
    }
  }

  /** An environment in the node's home, on this node while it stays connected. */
  private async env(context: Context): Promise<RemoteExecutionEnv> {
    const nodeFor = async (): Promise<RemoteNode> => {
      const remote = this.hub.get(this.node.id);
      if (!remote.connected) throw new NodeUnavailableError(this.node);
      return remote;
    };
    const home = await new RemoteExecutionEnv({ cwd: "/", nodeFor, strict: true }).absolutePath("~", context);
    if (!home.ok) throw new Error(`Cannot find the home directory of "${this.node.name}": ${home.error.message}`);
    return new RemoteExecutionEnv({ cwd: home.value, nodeFor, strict: true });
  }
}

const contextOf = (signal?: AbortSignal): Context => signal ? withAbortSignal(signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT;

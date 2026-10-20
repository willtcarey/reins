/**
 * A node's machine as a whole (`NodeHost`, from `NodeModel.host`): its files and commands anywhere on it,
 * not in a checkout, for scripts (`api.nodes.readFile`, `writeFile`, `copy`, `run`). Built on the operations
 * under the agent's tools (`NodeDirClient`: `fs.*` and `pi.exec`, with Pi's semantics), so no protocol of
 * its own.
 */
import { applyShellOutputUpdate, type ShellExecResult, type ShellOutputView } from "@earendil-works/pi-agent-core";
import { NodeCommandError, NodeDirClient, NodeFileError, type CallOptions } from "../nodes/node-dir-client.js";
import type { NodeHub } from "../state.js";

/** The bytes a copy holds at once: one range of the file, read and then written. Read in ranges, not as one
 * stream: a node sends a stream as fast as it reads it, and the server fails a stream it holds too much of
 * (`MAX_STREAM_BUFFER_BYTES`), which a destination slower than the source would make it. */
export const COPY_RANGE_BYTES = 8 * 1024 * 1024;

/** The output a command's stream carries as it runs (its view): the protocol's bound on it
 * (`MAX_EXEC_VIEW_BYTES`, which the protocol package does not export). Output beyond it is read from the file Pi spills it to. */
const OUTPUT_VIEW_BYTES = 1024 * 1024;

/** What a command run on a node gave: its exit code and its output (stdout and stderr together), the first
 * `maxBytes` of it, `truncated` when there was more. */
export interface NodeRunResult { exitCode: number; output: string; truncated: boolean }

/** A file larger than its reader may hold (`readFile`'s `maxBytes`). */
export class FileTooLargeError extends Error {
  constructor(readonly path: string, readonly node: { id: string; name: string }, readonly size: number, readonly maxBytes: number) {
    super(`Cannot read ${path} on "${node.name}": it has ${size} bytes, more than the ${maxBytes} it may hold`);
    this.name = "FileTooLargeError";
  }
}

/** Control characters Pi leaves out of a command's output view (its `sanitizeShellOutput`, not exported):
 * left out of output read from its spill file too, so the output reads the same whatever its size. */
const INVALID_SHELL_OUTPUT = /[\x00-\x08\x0b-\x1f\ufff9-\ufffb]/g; // eslint-disable-line no-control-regex -- control characters are what it removes
const quoted = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

/**
 * One node's files and commands, anywhere on its machine. Relative paths, and commands, start in the node's
 * home; `~` is it. Nothing is confined: the server can already run anything on a node. Unlike a session's
 * tools, nothing waits for the node: one whose link drops mid-call fails the call (`RpcFailure`
 * `unavailable`). What a call returns is held in the server's memory, so its caller bounds it (`maxBytes`);
 * a copy holds one range at a time, so it copies a file of any size.
 */
export class NodeHost {
  constructor(private readonly hub: NodeHub, private readonly node: { id: string; name: string }) {}

  /** The whole file's bytes. Throws `FileTooLargeError` for a file larger than `maxBytes`, and with the
   * node's answer for one it cannot read (missing, a directory, …). */
  async readFile(path: string, { maxBytes, signal }: { maxBytes: number; signal?: AbortSignal }): Promise<Uint8Array> {
    const home = await this.home({ signal });
    const read = await refused(home.readFileRange(path, { maxBytes, signal }), why => this.cannotRead(path, why));
    if (read.size > maxBytes) throw new FileTooLargeError(path, this.node, read.size, maxBytes);
    return read.bytes;
  }

  /** Writes the file whole (UTF-8 for text), as Pi's write tool does: its directories created, a file
   * there replaced. */
  async writeFile(path: string, content: string | Uint8Array, { signal }: { signal?: AbortSignal } = {}): Promise<void> {
    const home = await this.home({ signal });
    await refused(home.writeFile(path, content, { signal }), why => new Error(`Cannot write ${path} on "${this.node.name}": ${why}`));
  }

  /**
   * Copies the file at `path` to `toPath` on `to` (this node too), as `writeFile` writes it, whatever its
   * size: read in ranges of `COPY_RANGE_BYTES`, each written on as it comes, so no more is held at once.
   * Nothing is at `toPath` until the whole file is there. Throws with the node's answer for a file it
   * cannot read or write, and for one whose size changes while it is copied. Returns its size.
   */
  async copyTo(path: string, to: NodeHost, toPath: string, { signal }: { signal?: AbortSignal } = {}): Promise<{ bytes: number }> {
    const [from, into] = await Promise.all([this.home({ signal }), to.home({ signal })]);
    const cannotRead = (why: string) => this.cannotRead(path, why);
    let size: number | undefined;
    async function* ranges() {
      for (let offset = 0; offset < (size ?? 1); ) {
        const read = await refused(from.readFileRange(path, { offset, maxBytes: COPY_RANGE_BYTES, signal }), cannotRead);
        const changed = (size !== undefined && read.size !== size) || (read.bytes.byteLength === 0 && offset < read.size);
        if (changed) throw cannotRead(`it changed while it was copied (${size ?? read.size} bytes, then ${read.size})`);
        size = read.size;
        offset += read.bytes.byteLength;
        yield read.bytes;
      }
    }
    await refused(into.writeFileFrom(toPath, ranges(), { signal }), why => new Error(`Cannot write ${toPath} on "${to.node.name}": ${why}`));
    return { bytes: size ?? 0 };
  }

  /**
   * Runs `command` with bash as the agent's bash tool runs it (`pi.exec`), in `cwd` (the node's home by
   * default), killed after `timeoutMs`. Its output beyond the view a command's stream carries
   * (`OUTPUT_VIEW_BYTES`) is read from the spill file Pi keeps on the node, up to `maxBytes`, and the file
   * then removed. Throws when it times out, is aborted or cannot be run (`cwd` missing, its outcome unknown).
   */
  async run(command: string, { cwd, timeoutMs, maxBytes, signal }: { cwd?: string; timeoutMs: number; maxBytes: number; signal?: AbortSignal }): Promise<NodeRunResult> {
    const home = await this.home({ signal });
    let view: ShellOutputView | undefined;
    let exited: ShellExecResult | undefined;
    try {
      exited = await home.exec(command, {
        ...(cwd === undefined ? {} : { cwd }),
        timeout: timeoutMs / 1000,
        capture: { limits: { maxBytes: OUTPUT_VIEW_BYTES, maxLines: Number.MAX_SAFE_INTEGER, retain: "head" }, spill: true },
        onUpdate: update => { view = applyShellOutputUpdate(view, update); },
        signal,
      });
      if (!exited.truncation.truncated) return { exitCode: exited.exitCode, output: view?.text ?? "", truncated: false };
      if (!exited.spillPath) throw new Error(`Command on "${this.node.name}": its output was not kept beyond ${OUTPUT_VIEW_BYTES} bytes`);
      const spilled = await refused(home.readFileRange(exited.spillPath, { maxBytes, signal }), why => new Error(`Command on "${this.node.name}": cannot read its output (${why})`));
      const output = Buffer.from(spilled.bytes).toString("utf8").replace(INVALID_SHELL_OUTPUT, "");
      return { exitCode: exited.exitCode, output, truncated: spilled.size > maxBytes };
    } catch (error) {
      if (!(error instanceof NodeCommandError)) throw error;
      if (error.code === "timeout") throw new Error(`Command timed out after ${timeoutMs} ms on "${this.node.name}"`, { cause: error });
      throw new Error(`Command failed on "${this.node.name}": ${error.message}`, { cause: error });
    } finally {
      const spillPath = exited?.spillPath ?? view?.spillPath;
      if (spillPath) await home.exec(`rm -f -- ${quoted(spillPath)}`).catch(() => undefined);
    }
  }

  private cannotRead(path: string, why: string): Error {
    return new Error(`Cannot read ${path} on "${this.node.name}": ${why}`);
  }

  /** A client for the node's home, which does not wait for the node. */
  private async home(options: CallOptions): Promise<NodeDirClient> {
    const at = (cwd: string) => new NodeDirClient({ cwd, node: this.hub.get(this.node.id), waitForNode: false });
    return at(await refused(at("/").absolutePath("~", options), why => new Error(`Cannot find the home directory of "${this.node.name}": ${why}`)));
  }
}

/** `work`'s value, the node's refusal of its file (a `NodeFileError`) thrown as `refusal(its message)`. */
async function refused<T>(work: Promise<T>, refusal: (why: string) => Error): Promise<T> {
  try { return await work; }
  catch (error) { throw error instanceof NodeFileError ? refusal(error.message) : error; }
}

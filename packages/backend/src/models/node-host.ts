import { applyShellOutputUpdate, type ShellExecResult, type ShellOutputView } from "@earendil-works/pi-agent-core";
import { MAX_EXEC_VIEW_BYTES } from "@reins/node-protocol";
import { NodeCommandError, NodeDirClient, NodeFileError, type CallOptions } from "../nodes/node-dir-client.js";
import type { NodeHub } from "../state.js";

/** A copy reads in ranges, not one stream: a node sends a stream as fast as it reads it, and the server
 * fails a stream it holds too much of (`MAX_STREAM_BUFFER_BYTES`), as a slow destination would make it. */
export const COPY_RANGE_BYTES = 8 * 1024 * 1024;

/** `output` is stdout and stderr together. */
export interface NodeRunResult { exitCode: number; output: string; truncated: boolean }

export class FileTooLargeError extends Error {
  constructor(readonly path: string, readonly node: { id: string; name: string }, readonly size: number, readonly maxBytes: number) {
    super(`Cannot read ${path} on "${node.name}": it has ${size} bytes, more than the ${maxBytes} it may hold`);
    this.name = "FileTooLargeError";
  }
}

/** As Pi's `sanitizeShellOutput` (not exported), for spilled output too, so output reads the same whatever
 * its size. */
const INVALID_SHELL_OUTPUT = /[\x00-\x08\x0b-\x1f\ufff9-\ufffb]/g; // eslint-disable-line no-control-regex -- control characters are what it removes
const quoted = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

/** Nothing is confined: the server can already run anything on a node. Unlike a session's tools, nothing
 * waits for the node. What a call returns is held in the server's memory, so its caller bounds it. */
export class NodeHost {
  constructor(private readonly hub: NodeHub, private readonly node: { id: string; name: string }) {}

  async readFile(path: string, { maxBytes, signal }: { maxBytes: number; signal?: AbortSignal }): Promise<Uint8Array> {
    const home = await this.home({ signal });
    const read = await refused(home.readFileRange(path, { maxBytes, signal }), why => this.cannotRead(path, why));
    if (read.size > maxBytes) throw new FileTooLargeError(path, this.node, read.size, maxBytes);
    return read.bytes;
  }

  async writeFile(path: string, content: string | Uint8Array, { signal }: { signal?: AbortSignal } = {}): Promise<void> {
    const home = await this.home({ signal });
    await refused(home.writeFile(path, content, { signal }), why => new Error(`Cannot write ${path} on "${this.node.name}": ${why}`));
  }

  /** Holds one range at a time, so copies a file of any size. Nothing is at `toPath` until it is whole. */
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

  /** Output past what a command's stream carries (`MAX_EXEC_VIEW_BYTES`) is read from Pi's spill file on
   * the node, which is then removed. */
  async run(command: string, { cwd, timeoutMs, maxBytes, signal }: { cwd?: string; timeoutMs: number; maxBytes: number; signal?: AbortSignal }): Promise<NodeRunResult> {
    const home = await this.home({ signal });
    let view: ShellOutputView | undefined;
    let exited: ShellExecResult | undefined;
    try {
      exited = await home.exec(command, {
        ...(cwd === undefined ? {} : { cwd }),
        timeout: timeoutMs / 1000,
        capture: { limits: { maxBytes: MAX_EXEC_VIEW_BYTES, maxLines: Number.MAX_SAFE_INTEGER, retain: "head" }, spill: true },
        onUpdate: update => { view = applyShellOutputUpdate(view, update); },
        signal,
      });
      if (!exited.truncation.truncated) return { exitCode: exited.exitCode, output: view?.text ?? "", truncated: false };
      if (!exited.spillPath) throw new Error(`Command on "${this.node.name}": its output was not kept beyond ${MAX_EXEC_VIEW_BYTES} bytes`);
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

  private async home(options: CallOptions): Promise<NodeDirClient> {
    const at = (cwd: string) => new NodeDirClient({ cwd, node: this.hub.get(this.node.id), waitForNode: false });
    return at(await refused(at("/").absolutePath("~", options), why => new Error(`Cannot find the home directory of "${this.node.name}": ${why}`)));
  }
}

async function refused<T>(work: Promise<T>, refusal: (why: string) => Error): Promise<T> {
  try { return await work; }
  catch (error) { throw error instanceof NodeFileError ? refusal(error.message) : error; }
}

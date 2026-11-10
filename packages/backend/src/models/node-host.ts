import { constants } from "node:os";
import { NodeDirClient, NodeFileError, type CallOptions } from "../nodes/node-dir-client.js";
import type { NodeHub } from "../state.js";
import { NodeProcess, type NodeProcessSpec } from "../nodes/node-process.js";

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

/** As Pi's `sanitizeShellOutput` (not exported): a command's output reads as an agent's bash shows it. */
const INVALID_SHELL_OUTPUT = /[\x00-\x08\x0b-\x1f\ufff9-\ufffb]/g; // eslint-disable-line no-control-regex -- control characters are what it removes

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

  /** Whether `path` is a file the node can read (a symlink is followed); a directory is not. */
  async hasFile(path: string, { signal }: { signal?: AbortSignal } = {}): Promise<boolean> {
    const home = await this.home({ signal });
    try {
      await home.readFileRange(path, { maxBytes: 1, signal });
      return true;
    } catch (error) {
      if (error instanceof NodeFileError) return false;
      throw error;
    }
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

  /** Bash (`bash -c`, as Pi runs a command), run to its end as git is (`NodeDirClient.spawner`): stdout and
   * stderr together, in the order written, the first `maxBytes` kept and the rest read and dropped. */
  async run(command: string, { cwd = ".", env, timeoutMs, maxBytes, signal }: { cwd?: string; env?: Readonly<Record<string, string>>; timeoutMs: number; maxBytes: number; signal?: AbortSignal }): Promise<NodeRunResult> {
    signal?.throwIfAborted();
    const home = await this.home({ signal });
    const at = await refused(home.absolutePath(cwd, { signal }), why => new Error(`Cannot find ${cwd} on "${this.node.name}": ${why}`));
    const spawn = new NodeDirClient({ cwd: at, node: this.hub.get(this.node.id), waitForNode: false }).spawner({ signal });
    let started;
    try {
      started = await spawn(["bash", "-c", `exec 2>&1\n${command}`], env === undefined ? {} : { env: { ...env } });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw new Error(`Command failed on "${this.node.name}": ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    const { stdout, exited } = started;
    let timedOut = false;
    const reader = stdout.getReader();
    // Cancelling stdout stops the process on the node, and ends the read below.
    const stop = () => { void reader.cancel().catch(() => undefined); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    signal?.addEventListener("abort", stop, { once: true });
    const kept: Uint8Array[] = [];
    let keptBytes = 0;
    let truncated = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const room = maxBytes - keptBytes;
        if (value.byteLength > room) truncated = true;
        if (room > 0) { kept.push(value.subarray(0, room)); keptBytes += Math.min(room, value.byteLength); }
      }
      const exit = await exited;
      const exitCode = exit.code ?? 128 + (exit.signal ? (constants.signals[exit.signal as keyof typeof constants.signals] ?? 0) : 0); // eslint-disable-line typescript-eslint/consistent-type-assertions -- a signal's name, as the node reports it
      return { exitCode, output: Buffer.concat(kept).toString("utf8").replace(INVALID_SHELL_OUTPUT, ""), truncated };
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (timedOut) throw new Error(`Command timed out after ${timeoutMs} ms on "${this.node.name}"`, { cause: error });
      throw new Error(`Command failed on "${this.node.name}": ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
    }
  }

  /** A long-running process (`NodeProcess`); `cwd` resolves as `run`'s does. */
  async spawn(command: string | readonly string[], { cwd = ".", ...spec }: Omit<NodeProcessSpec, "cwd" | "argv" | "command"> & { cwd?: string }): Promise<NodeProcess> {
    const home = await this.home(spec.signal ? { signal: spec.signal } : {});
    const at = await refused(home.absolutePath(cwd, spec.signal ? { signal: spec.signal } : {}), why => new Error(`Cannot find ${cwd} on "${this.node.name}": ${why}`));
    const what = typeof command === "string" ? { command } : { argv: [...command] };
    try {
      return await NodeProcess.start(this.hub.get(this.node.id), { ...spec, ...what, cwd: at });
    } catch (error) {
      if (spec.signal?.aborted) throw error;
      const shown = typeof command === "string" ? command : command.join(" ");
      throw new Error(`Cannot start ${shown.slice(0, 100)} on "${this.node.name}": ${error instanceof Error ? error.message : String(error)}`, { cause: error });
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

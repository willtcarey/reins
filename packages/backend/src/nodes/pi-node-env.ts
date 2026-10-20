/**
 * Pi's `ExecutionEnv` over a `NodeDirClient` (ADR-029): a directory on a node as Pi's tools and its
 * discovery of context files and skills take it. Each call is the client's, its context's signal its
 * signal, and its outcome answered as Pi's local environment answers it: a value, or Pi's `FileError` or
 * `ExecutionError`. What Pi asks of an environment that the node does not serve answers `not_supported`.
 */
import { posix } from "node:path";
import {
  err, ExecutionError, FileError, ok, toError,
  type Context, type ExecutionEnv, type FileInfo, type Result, type ShellExecOptions, type ShellExecResult,
} from "@earendil-works/pi-agent-core";
import { NodeCommandError, NodeFileError, type CallOptions, type CommandCall, type NodeDirClient } from "./node-dir-client.js";

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

export interface PiNodeEnvOptions {
  /** A file operation the node did not answer (unreachable past its retries, a failure of the node or of
   * the link, an abort) throws, instead of answering Pi's file error: for discovering the checkout's
   * resources, which takes a file error as the file's own (missing or unreadable) and goes on without it. */
  strict?: boolean;
}

export class PiNodeEnv implements ExecutionEnv {
  private readonly strict: boolean;

  constructor(readonly client: NodeDirClient, { strict = false }: PiNodeEnvOptions = {}) {
    this.strict = strict;
  }

  get cwd(): string { return this.client.cwd; }

  /** A file operation of the client with the context's signal, as Pi's `Result`: the node's refusal is
   * Pi's file error; one the node did not answer is an `aborted` or `unknown` one, or thrown when `strict`. */
  private async file<T>(context: Context, call: (options: CallOptions) => Promise<T>): Promise<Result<T, FileError>> {
    const signal = context.abortSignal;
    try {
      return ok(await call({ signal }));
    } catch (error) {
      if (error instanceof NodeFileError) return err(new FileError(error.code, error.message, error.path));
      if (this.strict) throw error;
      if (signal?.aborted) return err(new FileError("aborted", "aborted"));
      return err(new FileError("unknown", messageOf(error), undefined, toError(error)));
    }
  }

  absolutePath(path: string, context: Context): Promise<Result<string, FileError>> {
    return this.file(context, options => this.client.absolutePath(path, options));
  }

  canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
    return this.file(context, options => this.client.canonicalPath(path, options));
  }

  fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
    return this.file(context, options => this.client.fileInfo(path, options));
  }

  /** `fileInfo`'s answer, as Pi's local environment reads it: a missing path does not exist. */
  async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
    const info = await this.fileInfo(path, context);
    if (info.ok) return ok(true);
    return info.error.code === "not_found" ? ok(false) : info;
  }

  listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
    return this.file(context, options => this.client.listDir(path, options));
  }

  async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
    return this.file(context, async options => (await this.client.readFileRange(path, options)).bytes);
  }

  /** The file's bytes as UTF-8, decoded as Pi's local environment decodes them (a byte-order mark is kept). */
  async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
    const bytes = await this.readBinaryFile(path, context);
    return bytes.ok ? ok(Buffer.from(bytes.value.buffer, bytes.value.byteOffset, bytes.value.byteLength).toString("utf8")) : bytes;
  }

  writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    return this.file(context, options => this.client.writeFile(path, content, options));
  }

  async joinPath(parts: string[], _context?: Context): Promise<Result<string, FileError>> {
    return ok(posix.join(...parts));
  }

  // Not used by Pi's tools or its skill discovery, so not served by nodes.
  readTextLines(path: string): Promise<Result<string[], FileError>> { return unsupported("readTextLines", path); }
  appendFile(path: string): Promise<Result<void, FileError>> { return unsupported("appendFile", path); }
  renameFile(path: string): Promise<Result<void, FileError>> { return unsupported("renameFile", path); }
  createDir(path: string): Promise<Result<void, FileError>> { return unsupported("createDir", path); }
  remove(path: string): Promise<Result<void, FileError>> { return unsupported("remove", path); }
  createTempDir(): Promise<Result<string, FileError>> { return unsupported("createTempDir"); }
  createTempFile(): Promise<Result<string, FileError>> { return unsupported("createTempFile"); }

  exec(command: string, options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
    return this.execCommand({ execId: crypto.randomUUID(), attach: false }, command, options, context);
  }

  /** `exec` under the ID `call` names, picking up the command already sent under it with `attach`
   * (`NodeDirClient.exec`): for a tool call that recorded its command's ID. */
  async execCommand(call: CommandCall, command: string, options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
    const signal = context.abortSignal;
    const { onUpdate, ...rest } = options ?? {};
    try {
      return ok(await this.client.exec(command, { ...rest, call, signal, ...(onUpdate ? { onUpdate: update => onUpdate(update, context) } : {}) }));
    } catch (error) {
      if (error instanceof NodeCommandError) return err(new ExecutionError(error.code, error.message, error.cause === undefined ? undefined : toError(error.cause)));
      if (signal?.aborted) return err(new ExecutionError("aborted", "aborted"));
      return err(new ExecutionError("unknown", messageOf(error), toError(error)));
    }
  }

  /** Kills the commands the client still runs, unless it was detached. */
  cleanup(_context?: Context): Promise<void> {
    return this.client.cleanup();
  }

  /** Leaves the client's commands running on the node (`NodeDirClient.detach`). */
  detach(): void {
    this.client.detach();
  }
}

function unsupported<T>(op: string, path?: string): Promise<Result<T, FileError>> {
  return Promise.resolve(err(new FileError("not_supported", `${op} is not supported on a node`, path)));
}

/**
 * The node's files (`fs.*`, ADR-029): Pi's local file operations (`NodeExecutionEnv`) at each call's
 * `cwd`, so the server gets what a local environment returns on this machine, for the agent's tools, its
 * discovery of a checkout's context files and skills, and the file browser. Nothing is confined to the
 * checkout: the server confines what a browser may name. A read streams the file from disk (Pi's would
 * hold it whole); a write longer than one chunk is kept in the node's data directory until its last chunk.
 */
import { createHash } from "node:crypto";
import { appendFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { dirname, join } from "node:path";
// Pi's narrowest entry points: its root would bring the whole agent harness into the node bundle.
import type { FileError, Result } from "@earendil-works/pi-agent-core";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/harness/env/nodejs";
import {
  MAX_DIRECTORY_ENTRIES, MAX_FILE_ERROR_CHARS, NodeRejection,
  type FileErrorData, type FsInfo, type FsInfoResult, type FsList, type FsListResult, type FsPath, type FsPathResult, type FsRead, type FsReadResult, type FsWrite,
  type FsWriteResult,
} from "@reins/node-protocol";
import type { OpenStreamSource } from "./node.js";

/** Writes recorded as done, so a repeated last chunk of one is answered as written. */
const FINISHED_WRITES = 1024;

/**
 * Where `fs.write` keeps the chunks of a file until its last: under the node's data directory, not
 * where the file goes, so a write that never finishes leaves nothing there. What is left is removed when
 * the node starts (`clear`): no write survives a restart, since its next chunk would find nothing kept
 * and be refused.
 */
export function partialWrites(dataDir: string) {
  const dir = join(dataDir, "partial-writes");
  return {
    dir,
    clear: () => rmSync(dir, { recursive: true, force: true }),
    /** Where the chunks of write `writeId` are kept. */
    pathFor: (writeId: string) => join(dir, createHash("sha256").update(writeId).digest("hex")),
  };
}
export type PartialWrites = ReturnType<typeof partialWrites>;

/** The node's file operations. */
export function createFiles(partials: PartialWrites) {
  const finishedWrites = new Set<string>();
  const env = (cwd: string) => new NodeExecutionEnv({ cwd });
  const context = BACKGROUND_CONTEXT;
  return {
    /** `fs.info`. */
    async info({ cwd, path }: FsInfo): Promise<FsInfoResult> {
      return answer(await env(cwd).fileInfo(path, context));
    },
    /** `fs.list`: the directory's children without their paths, the directory's absolute path once. */
    async list({ cwd, path }: FsList): Promise<FsListResult> {
      const pi = env(cwd);
      const directory = await pi.absolutePath(path, context);
      if (!directory.ok) return failed(directory.error);
      const listed = await pi.listDir(directory.value, context);
      if (!listed.ok) return failed(listed.error);
      return { ok: true, value: { path: directory.value, entries: listed.value.slice(0, MAX_DIRECTORY_ENTRIES).map(({ path: _, ...entry }) => entry) } };
    },
    /** `fs.absolutePath`. */
    async absolutePath({ cwd, path }: FsPath): Promise<FsPathResult> {
      return answer(await env(cwd).absolutePath(path, context));
    },
    /** `fs.canonicalPath`. */
    async canonicalPath({ cwd, path }: FsPath): Promise<FsPathResult> {
      return answer(await env(cwd).canonicalPath(path, context));
    },
    /** `fs.read`: its size is taken now, its bytes when the stream starts. Fails as Pi's `readBinaryFile`
     * would. */
    async read({ cwd, path, offset = 0, maxBytes }: FsRead): Promise<{ result: FsReadResult; source: OpenStreamSource }> {
      const file = await env(cwd).absolutePath(path, context);
      if (!file.ok) return { result: failed(file.error), source: empty };
      // Opened as Pi's read opens it, so a failure is the one it reports.
      let stats;
      try {
        const handle = await open(file.value, "r");
        try { stats = await handle.stat(); } finally { await handle.close(); }
      } catch (error) { return { result: { ok: false, error: fileError(error, file.value) }, source: empty }; }
      if (stats.isDirectory()) return { result: { ok: false, error: { code: "is_directory", message: "EISDIR: illegal operation on a directory, read", path: file.value } }, source: empty };
      if (!stats.isFile()) return { result: { ok: false, error: { code: "invalid", message: "Unsupported file type", path: file.value } }, source: empty };
      // Not `Bun.file(file).slice(0, maxBytes).stream()`: in Bun 1.3.9 that stream never ends for a slice of
      // a large file. Ending the iteration early destroys the read stream.
      return { result: { ok: true, value: { size: stats.size } }, source: () => createReadStream(file.value, { start: offset, ...(maxBytes === undefined ? {} : { end: offset + maxBytes - 1 }) }) };
    },
    /** `fs.write`: one chunk (see `fsWriteParams`). */
    async write({ cwd, path, writeId, offset, data, last }: FsWrite): Promise<FsWriteResult> {
      const chunk = Buffer.from(data, "base64");
      if (offset === 0 && last) return wrote(await env(cwd).writeFile(path, chunk, context));
      if (last && finishedWrites.has(writeId)) return { ok: true, value: null };
      const kept = partials.pathFor(writeId);
      const written = existsSync(kept) ? statSync(kept).size : 0;
      if (offset > written) throw new NodeRejection("invalid_request", `Chunk out of order: ${written} bytes written, chunk at ${offset}`);
      if (offset === 0) { mkdirSync(partials.dir, { recursive: true }); writeFileSync(kept, chunk); }
      else { truncateSync(kept, offset); appendFileSync(kept, chunk); }
      if (!last) return { ok: true, value: null };
      let result: FsWriteResult;
      try { result = await place(cwd, path, kept); }
      finally { rmSync(kept, { force: true }); }
      if (result.ok) {
        finishedWrites.add(writeId);
        if (finishedWrites.size > FINISHED_WRITES) finishedWrites.delete(finishedWrites.values().next().value!);
      }
      return result;
    },
  };

  /** As Pi's `writeFile` writes (its directories created, through a symlink there), but not held in memory:
   * a long write may be any size. */
  async function place(cwd: string, path: string, kept: string): Promise<FsWriteResult> {
    const file = await env(cwd).absolutePath(path, context);
    if (!file.ok) return failed(file.error);
    try {
      await mkdir(dirname(file.value), { recursive: true });
      // Streamed, not `copyFile`: a failure is the target's, as Pi's would be, not the kept file's.
      await pipeline(createReadStream(kept), createWriteStream(file.value));
      return { ok: true, value: null };
    } catch (error) {
      return { ok: false, error: fileError(error, file.value) };
    }
  }
}

/** The stream of an operation that answers no bytes. */
const empty: OpenStreamSource = async function* () {};

/** Pi's result as it crosses the wire. */
function answer<T>(result: Result<T, FileError>): { ok: true; value: T } | { ok: false; error: FileErrorData } {
  return result.ok ? { ok: true, value: result.value } : failed(result.error);
}
/** A write's result as it crosses the wire. */
function wrote(result: Result<void, FileError>): FsWriteResult {
  return result.ok ? { ok: true, value: null } : failed(result.error);
}

/** Pi's file error as it crosses the wire, cut to the wire's bounds. */
function failed(error: FileError): { ok: false; error: FileErrorData } {
  return {
    ok: false,
    error: { code: error.code, message: error.message.slice(0, MAX_FILE_ERROR_CHARS), ...(error.path === undefined ? {} : { path: error.path.slice(0, MAX_FILE_ERROR_CHARS) }) },
  };
}

/** A filesystem exception as Pi's local environment reports it (its `FileError` codes). */
function fileError(error: unknown, path: string): FileErrorData {
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  const message = (error instanceof Error ? error.message : String(error)).slice(0, MAX_FILE_ERROR_CHARS);
  const errorPath = error instanceof Error && "path" in error && typeof error.path === "string" ? error.path : path;
  const codes: Record<string, FileErrorData["code"]> = {
    ABORT_ERR: "aborted", ENOENT: "not_found", EACCES: "permission_denied", EPERM: "permission_denied", ENOTDIR: "not_directory", EISDIR: "is_directory", EINVAL: "invalid",
  };
  return { code: (typeof code === "string" && codes[code]) || "unknown", message, path: errorPath.slice(0, MAX_FILE_ERROR_CHARS) };
}

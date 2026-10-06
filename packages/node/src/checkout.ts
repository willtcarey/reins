/**
 * Operations on a source's checkout that the server asks for (`process.run`, `fs.list`, `fs.read`, `fs.write`). The server
 * resolves the checkout's path and sends it as `cwd` (as in a session binding); the node has no sources
 * table to check it against yet.
 */
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { MAX_DIRECTORY_ENTRIES, MAX_PROCESS_STDERR_CHARS, NodeRejection, type DirectoryEntry, type FsList, type FsListResult, type FsRead, type FsReadResult, type FsWrite, type FsWriteResult, type OpenStreamSource, type ProcessExit, type ProcessRun } from "@reins/node-protocol";

const checkoutExists = (cwd: string) => {
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new NodeRejection("not_found", `Source checkout not found: ${cwd}`);
};

/** `process.run`: refuses a missing checkout or program; the returned source spawns `argv` (no shell)
 * when the stream starts, yields its stdout and returns its exit. Stopping the stream kills it. */
export function runProcess({ cwd, argv, env }: ProcessRun): OpenStreamSource {
  checkoutExists(cwd);
  const environment = { ...process.env, ...env };
  const [program] = argv;
  if (!program || !Bun.which(program, { cwd, PATH: environment.PATH ?? "" })) throw new NodeRejection("invalid_request", `Program not found: ${program}`);
  return async function* (signal) {
    const proc = Bun.spawn(argv, { cwd, env: environment, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const kill = () => proc.kill();
    signal.addEventListener("abort", kill, { once: true });
    // Drained alongside stdout so the process never blocks on a full stderr pipe.
    const stderr = tail(proc.stderr, MAX_PROCESS_STDERR_CHARS);
    try {
      for await (const chunk of proc.stdout) yield chunk;
      await proc.exited;
      return { code: proc.exitCode, signal: proc.signalCode, stderr: await stderr } satisfies ProcessExit;
    } finally {
      signal.removeEventListener("abort", kill);
      // Stopped before it exited (cancelled, or the stream abandoned).
      if (proc.exitCode === null && proc.signalCode === null) proc.kill();
    }
  };
}

/** The last `max` characters of a stream's text. */
async function tail(stream: ReadableStream<Uint8Array>, max: number): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  try {
    for await (const chunk of stream) text = (text + decoder.decode(chunk, { stream: true })).slice(-max);
  } catch { /* the process was killed */ }
  return (text + decoder.decode()).slice(-max);
}

/** `path` within the checkout `cwd`, refusing one that escapes it. */
function checkoutPath(cwd: string, path: string): string {
  checkoutExists(cwd);
  const root = resolve(cwd);
  const resolved = resolve(root, path);
  if (resolved !== root && !resolved.startsWith(root + sep)) throw new NodeRejection("invalid_request", "Path traversal not allowed");
  return resolved;
}

/** `fs.list`: one directory of the checkout, as the file browser shows it. */
export function listDirectory({ cwd, path }: FsList): FsListResult {
  const directory = checkoutPath(cwd, path);
  let found;
  try { found = readdirSync(directory, { withFileTypes: true }); }
  catch { throw new NodeRejection("not_found", "Directory not found"); }
  const entries: DirectoryEntry[] = found
    .filter(entry => entry.isFile() || entry.isDirectory())
    .map(entry => ({ name: entry.name, type: entry.isDirectory() ? "directory" : "file" }));
  entries.sort((a, b) => a.type !== b.type ? (a.type === "directory" ? -1 : 1) : a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return { entries: entries.slice(0, MAX_DIRECTORY_ENTRIES) };
}

/** `fs.read`: one file of the checkout, its size now and its bytes (the first `maxBytes`) when the
 * stream starts. */
export function readFile({ cwd, path, maxBytes }: FsRead): FsReadResult & { source: OpenStreamSource } {
  const file = checkoutPath(cwd, path);
  let stats;
  try { stats = statSync(file); }
  catch { throw new NodeRejection("not_found", "File not found"); }
  if (!stats.isFile()) throw new NodeRejection("not_found", "File not found");
  // Not `Bun.file(file).slice(0, maxBytes).stream()`: in Bun 1.3.9 that stream never ends for a slice of
  // a large file. Ending the iteration early destroys the read stream.
  return { size: stats.size, source: () => createReadStream(file, maxBytes === undefined ? {} : { end: maxBytes - 1 }) };
}

/**
 * Where `fs.write` keeps files' bytes until their last chunk puts them in place: under the node's data
 * directory, not in the checkout, so a write that never finishes leaves nothing there. A file's bytes
 * are kept under a name derived from its path, so a write restarted at offset 0 replaces them. What is
 * left is removed when the node starts (`clear`): no write survives a restart, since its next chunk
 * would find no bytes and be refused.
 */
export function partialWrites(dataDir: string) {
  const dir = join(dataDir, "partial-writes");
  return {
    dir,
    clear: () => rmSync(dir, { recursive: true, force: true }),
    /** Where the bytes of the file at `file` (an absolute path) are kept. */
    pathFor: (file: string) => join(dir, createHash("sha256").update(file).digest("hex")),
  };
}
export type PartialWrites = ReturnType<typeof partialWrites>;

/** `fs.write`: one chunk of a file of the checkout (see `fsWriteParams`). A filesystem failure (a path
 * through a file, a directory in the way) refuses the chunk. */
export function writeFile({ cwd, path, offset, data, last }: FsWrite, partials: PartialWrites): FsWriteResult {
  const file = checkoutPath(cwd, path);
  if (file === resolve(cwd) || (existsSync(file) && statSync(file).isDirectory())) throw new NodeRejection("invalid_request", `Not a file path: ${path}`);
  const partial = partials.pathFor(file);
  const bytes = Buffer.from(data, "base64");
  try {
    if (offset === 0) {
      mkdirSync(partials.dir, { recursive: true });
      writeFileSync(partial, bytes);
    } else {
      const written = existsSync(partial) ? statSync(partial).size : 0;
      if (written !== offset) throw new NodeRejection("invalid_request", `Chunk out of order: ${written} bytes written, chunk at ${offset}`);
      appendFileSync(partial, bytes);
    }
    if (last) moveIntoPlace(partial, file);
  } catch (error) {
    if (error instanceof NodeRejection) throw error;
    throw new NodeRejection("invalid_request", `Cannot write ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { size: offset + bytes.byteLength };
}

/** Moves the finished bytes to `file`, creating its directories: a rename, or a copy when the data
 * directory is on another filesystem than the checkout. */
function moveIntoPlace(partial: string, file: string): void {
  mkdirSync(dirname(file), { recursive: true });
  try {
    renameSync(partial, file);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EXDEV")) throw error;
    copyFileSync(partial, file);
    rmSync(partial, { force: true });
  }
}

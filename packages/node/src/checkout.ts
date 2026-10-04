/**
 * Operations on a source's checkout that the server asks for (`process.run`, `fs.list`). The server
 * resolves the checkout's path and sends it as `cwd` (as in a session binding); the node has no sources
 * table to check it against yet.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { MAX_DIRECTORY_ENTRIES, MAX_PROCESS_STDERR_CHARS, NodeRejection, type DirectoryEntry, type FsList, type FsListResult, type OpenStreamSource, type ProcessExit, type ProcessRun } from "@reins/node-protocol";

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

/** `fs.list`: one directory of the checkout, as the file browser shows it. */
export function listDirectory({ cwd, path }: FsList): FsListResult {
  checkoutExists(cwd);
  const root = resolve(cwd);
  const directory = resolve(root, path);
  if (directory !== root && !directory.startsWith(root + sep)) throw new NodeRejection("invalid_request", "Path traversal not allowed");
  let found;
  try { found = readdirSync(directory, { withFileTypes: true }); }
  catch { throw new NodeRejection("not_found", "Directory not found"); }
  const entries: DirectoryEntry[] = found
    .filter(entry => entry.isFile() || entry.isDirectory())
    .map(entry => ({ name: entry.name, type: entry.isDirectory() ? "directory" : "file" }));
  entries.sort((a, b) => a.type !== b.type ? (a.type === "directory" ? -1 : 1) : a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return { entries: entries.slice(0, MAX_DIRECTORY_ENTRIES) };
}

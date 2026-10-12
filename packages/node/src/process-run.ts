/**
 * Processes in a source's checkout that the server runs (`process.run`: git, among others). The server
 * resolves the checkout's path and sends it as `cwd` (as in a session binding); the node keeps no list of
 * checkouts and works in the path it is sent (the server's sources are the record, ADR-026).
 */
import { existsSync, statSync } from "node:fs";
import { MAX_PROCESS_STDERR_CHARS, NodeRejection, type ProcessExit, type ProcessRun } from "@reins/node-protocol";
import type { OpenStreamSource } from "./node.js";

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

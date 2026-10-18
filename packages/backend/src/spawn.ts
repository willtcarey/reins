/**
 * Starting a process in a checkout: `nodeSpawn` on the checkout's node. `Git` runs its commands
 * through a `Spawn`.
 */

import type { ProcessExit } from "@reins/node-protocol";
import type { RemoteNode } from "./state.js";

/** Bound on a node accepting a `process.run` (spawning it), not on the process. */
export const PROCESS_START_TIMEOUT_MS = 10_000;

export interface SpawnOptions {
  /** Variables added to the process's environment. */
  env?: Record<string, string>;
  /** Stdout is arbitrary bytes rather than text (a node then sends it intact). */
  binary?: boolean;
}

/** A started process: its stdout, and its exit once it ended (with its stderr, or the tail of it).
 * Cancelling `stdout` kills the process. */
export interface SpawnedProcess {
  stdout: ReadableStream<Uint8Array>;
  exited: Promise<ProcessExit>;
}

/** Starts `argv` (no shell) in one checkout. Rejects when the process could not be started. */
export type Spawn = (argv: string[], options?: SpawnOptions) => Promise<SpawnedProcess>;

/**
 * Starts processes in the checkout at `cwd` on `node`: each opens a `process.run` stream, whose body is
 * stdout and whose end is the exit. A start rejects (an `RpcFailure`) when the node does not accept it
 * within `PROCESS_START_TIMEOUT_MS` or refuses it (a missing checkout or program); a link that drops later
 * fails `stdout` and `exited` alike.
 */
export function nodeSpawn(node: RemoteNode, cwd: string): Spawn {
  return async (argv, { env, binary } = {}) => {
    const input = { cwd, argv, ...(env ? { env } : {}), ...(binary ? { binary } : {}) };
    const { body, ended } = await node.openStream("process.run", input, { timeoutMs: PROCESS_START_TIMEOUT_MS });
    const exited = ended.then(exit => exit ?? Promise.reject(new Error(`Process stream ended without an exit: ${argv[0]}`)));
    // A consumer that cancels stdout need not await the exit.
    exited.catch(() => undefined);
    return { stdout: body, exited };
  };
}

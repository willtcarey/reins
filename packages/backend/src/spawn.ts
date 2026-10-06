/**
 * Starting a process in a checkout: `RemoteNode.spawn` on the checkout's node. `Git` runs its commands
 * through a `Spawn`.
 */

import type { ProcessExit } from "@reins/node-protocol";

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

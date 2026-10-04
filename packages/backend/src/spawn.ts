/**
 * Starting a process in a checkout, wherever the checkout is: `RemoteNode.spawn` on a node, `localSpawn`
 * on this machine. `Git` runs its commands through a `Spawn`.
 */

import type { ProcessExit } from "@reins/node-protocol";

export interface SpawnOptions {
  /** Variables for the process. The local spawner uses them as its whole environment; a node adds them
   * to its own. */
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

/** Spawns processes on this machine, in `cwd`. Transitional: the server reads its own checkout only
 * until every operation runs on the source's node (node-architecture.md *Remote readiness*). */
export function localSpawn(cwd: string): Spawn {
  return async (argv, { env } = {}) => {
    const proc = Bun.spawn(argv, { cwd, env, stdout: "pipe", stderr: "pipe" });
    // Drained alongside stdout so the process cannot block on a full stderr pipe.
    const stderr = new Response(proc.stderr).text().catch(() => "");
    const reader = proc.stdout.getReader();
    const stdout = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await reader.read();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
      async cancel() {
        await reader.cancel().catch(() => undefined);
        proc.kill();
      },
    });
    const exited = Promise.all([proc.exited, stderr])
      .then(([code, stderrText]) => ({ code: proc.signalCode ? null : code, signal: proc.signalCode ?? null, stderr: stderrText }));
    return { stdout, exited };
  };
}

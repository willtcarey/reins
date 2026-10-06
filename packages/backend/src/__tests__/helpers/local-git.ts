/**
 * Git on this machine: TEST UTILITY ONLY. Product code runs every process in a checkout on its node
 * (`RemoteNode.spawn`); tests that exercise `Git` itself, or set up and inspect a repository, run it here.
 */
import { Git } from "../../git.js";
import type { Spawn } from "../../spawn.js";

/** Spawns processes on this machine, in `cwd`, as a node's `process.run` would. */
export function localSpawn(cwd: string): Spawn {
  return async (argv, { env } = {}) => {
    const proc = Bun.spawn(argv, { cwd, env: env && { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
    // Drained alongside stdout so the process cannot block on a full stderr pipe.
    const stderr = new Response(proc.stderr).text().catch(() => "");
    const reader = proc.stdout.getReader();
    const stdout = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await reader.read();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
      // Resolves once the process exited, so whatever it does on `TERM` (e.g. removing temporary files)
      // is done when the cancel is.
      async cancel() {
        await reader.cancel().catch(() => undefined);
        proc.kill();
        await proc.exited.catch(() => undefined);
      },
    });
    const exited = Promise.all([proc.exited, stderr])
      .then(([code, stderrText]) => ({ code: proc.signalCode ? null : code, signal: proc.signalCode ?? null, stderr: stderrText }));
    return { stdout, exited };
  };
}

/** The git of a checkout on this machine. */
export function localGit(dir: string): Git {
  return new Git(localSpawn(dir));
}

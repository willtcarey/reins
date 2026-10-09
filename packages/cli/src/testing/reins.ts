import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../cli.js";

const entry = join(import.meta.dir, "../cli.ts");
/** The node home unless a test gives one: never created, so no test reads this machine's `~/.reins`. */
const NO_HOME = join(tmpdir(), `reins-cli-no-home-${randomUUID()}`);

/** Runs `reins …` in this process with `env` as its whole environment, collecting what it prints. */
export async function reins(args: readonly string[], env: Record<string, string | undefined> = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const output: string[] = [];
  const exitCode = await runCli(args, {
    env: { REINS_NODE_DATA_DIR: NO_HOME, ...env },
    out: text => { stdout.push(`${text}\n`); output.push(`${text}\n`); },
    err: text => { stderr.push(`${text}\n`); output.push(`${text}\n`); },
  });
  return { exitCode, stdout: stdout.join(""), stderr: stderr.join(""), output: output.join("") };
}

/** Runs `reins …` in its own process, as a shell would, with `env` over this process's environment. */
export async function spawnReins(args: readonly string[], env: Record<string, string | undefined> = {}) {
  const proc = Bun.spawn([process.execPath, entry, ...args], { env: { ...process.env, REINS_NODE_DATA_DIR: NO_HOME, ...env }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { exitCode, stdout, stderr };
}

/** The last line of `text`. */
export function lastLine(text: string): string | undefined {
  return text.trimEnd().split("\n").at(-1);
}

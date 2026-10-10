/**
 * Which of Bun's official releases runs on this machine, as the install script and Bun's own installer
 * choose it: private to NodeInstall (install.ts), which installs it when an update needs another Bun.
 */
import { readFile } from "node:fs/promises";

/** What picks Bun's release for a machine: its OS and CPU as Node names them, whether its libc is musl,
 * whether its CPU has AVX2, and whether this process runs under Rosetta. */
export interface Machine {
  platform: string;
  arch: string;
  musl: boolean;
  avx2: boolean;
  rosetta: boolean;
}

/**
 * The name of Bun's release build for `machine` (`bun-<target>.zip`): `linux` or `darwin`, `x64` or `aarch64`
 * (the native one under Rosetta), `-musl` on a musl Linux, and `-baseline` on an x64 CPU without AVX2,
 * which Bun's default x64 build needs.
 */
export function bunTarget({ platform, arch, musl, avx2, rosetta }: Machine): string {
  if (platform !== "linux" && platform !== "darwin") throw new Error(`Reins nodes run on Linux and macOS, not ${platform}`);
  let cpu: string;
  if (arch === "arm64") cpu = "aarch64";
  else if (arch === "x64") cpu = platform === "darwin" && rosetta ? "aarch64" : "x64";
  else throw new Error(`Bun has no release for ${arch} CPUs`);
  let target = `${platform}-${cpu}`;
  if (platform === "linux" && musl) target += "-musl";
  if (cpu === "x64" && !avx2) target += "-baseline";
  return target;
}

/** This machine, as `bunTarget` reads it. */
export async function thisMachine(): Promise<Machine> {
  const { platform, arch } = process;
  const musl = platform === "linux" && await run(["sh", "-c", "ls /lib/ld-musl-*"]).then(result => result.exitCode === 0);
  let avx2 = false;
  if (arch === "x64") {
    avx2 = platform === "linux"
      ? /\bavx2\b/.test(await readFile("/proc/cpuinfo", "utf8").catch(() => ""))
      : /\bAVX2\b/.test(await sysctl("machdep.cpu.leaf7_features"));
  }
  const rosetta = platform === "darwin" && await sysctl("sysctl.proc_translated") === "1";
  return { platform, arch, musl, avx2, rosetta };
}

/** Extracts `entry` of the zip at `zip` into `dir`, flat. */
export async function unzip(zip: string, entry: string, dir: string): Promise<void> {
  const { exitCode, stderr } = await run(["unzip", "-qoj", zip, entry, "-d", dir]);
  if (exitCode !== 0) throw new Error(`could not unpack Bun (unzip: ${stderr.trim() || `exit ${exitCode}`}; is unzip installed?)`);
}

/** Runs `argv`, without blocking the event loop (a node keeps its link alive meanwhile). */
export async function run(argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { exitCode, stdout, stderr };
}

async function sysctl(name: string): Promise<string> {
  return (await run(["sysctl", "-n", name]).catch(() => ({ stdout: "" }))).stdout.trim();
}

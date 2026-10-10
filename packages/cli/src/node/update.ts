/**
 * Updating an installed node to the build its server runs (ADR-025): when the server answers the node's
 * hello with `update {buildId, sha256, bunVersion}`, `reins node run` installs that build here, then
 * restarts on it (run.ts). See docs/dev/node-bundle.md *Updates*.
 *
 * The build comes from the server the node is paired with (`/nodes/builds/<buildId>/reins.js`) and is
 * checked against its sha256 before anything uses it; a build on another Bun first fetches that Bun's
 * official release, as the install script does (`bunTarget` is the one place that picks it in JS). Only
 * then is `current` flipped, so a failure at any step leaves the node home running what it ran.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BuildUpdate } from "@reins/node-protocol";
import { activateBuild, writeLauncher } from "./install.js";

/** How long one download may take. */
const DOWNLOAD_TIMEOUT_MS = 300_000;

/** What picks Bun's release for a machine: its OS and CPU as Node names them, whether its libc is musl,
 * whether its CPU has AVX2, and whether this process runs under Rosetta. */
export interface Machine {
  platform: string;
  arch: string;
  musl: boolean;
  avx2: boolean;
  rosetta: boolean;
}

export interface UpdateOptions {
  /** `globalThis.fetch` by default. */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** This machine, for Bun's release (`thisMachine()` by default). */
  machine?: Machine;
  /** Extracts `entry` of the zip at `zip` into `dir`, flat (`unzip -qoj` by default). */
  unpack?: (zip: string, entry: string, dir: string) => Promise<void>;
}

/**
 * Installs `update` in the node home: puts the build in `builds/<buildId>/reins.js` unless it is already
 * there (downloaded from `serverUrl` to a temporary file beside it, checked against `update.sha256`, renamed
 * into place), installs Bun `update.bunVersion` as `<home>/bun` if this process runs another, makes the build
 * current and writes the launcher. Throws why it failed, leaving `current` and the home's Bun as they were.
 */
export async function installUpdate(home: string, serverUrl: string, update: BuildUpdate, options: UpdateOptions = {}): Promise<void> {
  const fetch = options.fetch ?? globalThis.fetch;
  const short = update.buildId.slice(0, 12);
  const server = serverUrl.replace(/\/+$/, "");
  if (update.sha256 !== update.buildId) throw new Error(`build ${short} from ${server} names another checksum than its build ID`);
  const dir = join(home, "builds", update.buildId);
  const bundle = join(dir, "reins.js");
  if (!existsSync(bundle) || sha256(readFileSync(bundle)) !== update.sha256) {
    const bytes = await download(fetch, `${server}/nodes/builds/${update.buildId}/reins.js`, `could not download build ${short} from ${server}`);
    if (sha256(bytes) !== update.sha256) throw new Error(`build ${short} from ${server} does not match its checksum`);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temp = `${bundle}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, bytes, { mode: 0o600 });
      await rename(temp, bundle);
    } finally {
      await rm(temp, { force: true });
    }
  }
  if (update.bunVersion !== Bun.version) await installBun(home, update.bunVersion, { fetch, machine: options.machine ?? thisMachine(), unpack: options.unpack ?? unzip });
  await activateBuild(home, bundle);
  await writeLauncher(home);
}

/** Bun's official release `version` for `machine`, as `<home>/bun`: downloaded and unpacked in a temporary
 * directory in the home, checked to run as that version, and renamed over the previous one. */
async function installBun(home: string, version: string, { fetch, machine, unpack }: Required<UpdateOptions>): Promise<void> {
  const target = bunTarget(machine);
  const zip = await download(fetch, `https://github.com/oven-sh/bun/releases/download/bun-v${version}/bun-${target}.zip`, `could not download Bun ${version} for ${target} from GitHub`);
  const temp = await mkdtemp(join(home, "bun."));
  try {
    await writeFile(join(temp, "bun.zip"), zip);
    await unpack(join(temp, "bun.zip"), `bun-${target}/bun`, temp);
    const bun = join(temp, "bun");
    await chmod(bun, 0o755);
    const ran = Bun.spawnSync([bun, "--version"], { stdout: "pipe", stderr: "ignore" });
    if (ran.exitCode !== 0 || ran.stdout.toString().trim() !== version) throw new Error(`Bun ${version} for ${target} does not run on this machine`);
    await rename(bun, join(home, "bun"));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

/**
 * The name of Bun's release build for `machine` (`bun-<target>.zip`), as Bun's own installer and the install
 * script choose it: `linux` or `darwin`, `x64` or `aarch64` (the native one under Rosetta), `-musl` on a musl
 * Linux, and `-baseline` on an x64 CPU without AVX2, which Bun's default x64 build needs.
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
export function thisMachine(): Machine {
  const { platform, arch } = process;
  const musl = platform === "linux" && Bun.spawnSync(["sh", "-c", "ls /lib/ld-musl-*"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
  let avx2 = false;
  if (arch === "x64") avx2 = platform === "linux" ? /\bavx2\b/.test(readText("/proc/cpuinfo")) : /\bAVX2\b/.test(sysctl("machdep.cpu.leaf7_features"));
  const rosetta = platform === "darwin" && sysctl("sysctl.proc_translated") === "1";
  return { platform, arch, musl, avx2, rosetta };
}

function sysctl(name: string): string {
  return Bun.spawnSync(["sysctl", "-n", name], { stdout: "pipe", stderr: "ignore" }).stdout.toString().trim();
}

function readText(path: string): string {
  try { return readFileSync(path, "utf8"); } catch { return ""; }
}

async function download(fetch: NonNullable<UpdateOptions["fetch"]>, url: string, failure: string): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch (error) {
    throw new Error(`${failure}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (!response.ok) throw new Error(`${failure}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function unzip(zip: string, entry: string, dir: string): Promise<void> {
  const proc = Bun.spawn(["unzip", "-qoj", zip, entry, "-d", dir], { stdout: "ignore", stderr: "pipe" });
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) throw new Error(`could not unpack Bun (unzip: ${stderr.trim() || `exit ${exitCode}`}; is unzip installed?)`);
}

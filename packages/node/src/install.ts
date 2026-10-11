/**
 * This machine's installed node, as a whole (`NodeInstall`): its node home (`REINS_NODE_DATA_DIR`, default
 * `~/.reins`) and everything in it, from the pairing and the builds to the node running in the background.
 * Nothing else knows the home's layout. Also the environment a node bundle sets for itself
 * (`applyBundleEnv`) and what a node it starts must not inherit of that. See docs/dev/node-bundle.md *The
 * node home* and docs/dev/node-contract.md *Process model* and *Pairing and authentication*.
 *
 * It loads none of Pi: the bundle's entry imports it before Pi may be evaluated.
 *
 *   bun                      the pinned Bun (the install script's; an update replaces it)
 *   builds/<buildId>/        reins.js, the node bundle, and the docs it unpacks beside itself
 *   current -> builds/<id>   the build the launcher runs
 *   bin/reins                the launcher
 *   node.json, keys/         the pairing: the server, the node ID and its private key (0600)
 *   logs/node.log            the background node's output
 *   run/node-status.json     the node's pid and state, written by the node (`recorder`)
 *   run/launcher.json        the launcher `start` ran: its pid and start time
 *
 * The build ID is the bundle's sha256, as the server names it. A status file outlives its process (a
 * crash, a kill), and its pid may since name another process, so a recorded pid is trusted, or signalled,
 * only while that pid's start time is still the recorded one.
 */
import { createHash, createPrivateKey, randomUUID, type KeyObject } from "node:crypto";
import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, open, readFile, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { BuildUpdate, NodeKey } from "@reins/node-protocol";
import { z } from "zod";
import { bunTarget, run, thisMachine, unzip, type Machine } from "./install/bun.js";
import { processStartTime } from "./install/process.js";

/** A process's environment. */
export type Env = Record<string, string | undefined>;

/** The exit code that has the launcher run the node again at once, on whatever `current` then names: a
 * node that made a new build current exits with it. 75 (EX_TEMPFAIL), like the supervisor's reload code. */
export const RESTART_EXIT_CODE = 75;

/** How long `start` waits for the node to connect. */
const CONNECT_TIMEOUT_MS = 30_000;
/** How long `stop` waits for the node to exit: it pauses its runs (3 s) and closes them (5 s) first. */
const STOP_TIMEOUT_MS = 15_000;
/** How long one download may take. */
const DOWNLOAD_TIMEOUT_MS = 300_000;
const POLL_MS = 100;

const PAIRING_VERSION = 1;

/** A node ID as the server assigns it. It names the key file, so it is held to characters safe in a path. */
export const nodeIdSchema = z.string().regex(/^[\w-]+$/);

/** `node.json`. Loose: fields it does not know (written by a newer release of the same version) are kept. */
const pairingSchema = z.looseObject({
  version: z.literal(PAIRING_VERSION),
  serverUrl: z.string(),
  nodeId: z.string(),
  keyPath: z.string(),
});
/** This machine's pairing with a server: the server's URL (as `normalizeServerUrl` gives it), the node ID it
 * assigned and where the node's private key is. */
export type Pairing = z.infer<typeof pairingSchema>;

const statusFileSchema = z.object({
  pid: z.number().int().positive(),
  /** When the process started (`processStartTime`): a pid reused by another process has another. */
  started: z.string(),
  /** `connecting` until the first connection and while it redials; `refused`, `stopped` and `updating` (it
   * installed a new build and exited for its launcher to start that) are final. */
  state: z.enum(["connecting", "connected", "refused", "stopped", "updating"]),
  /** The bundle it runs; absent from source. */
  buildId: z.string().optional(),
  serverUrl: z.string(),
  /** When it entered `state` (ISO 8601). */
  since: z.string(),
  /** Why the server refused it. */
  message: z.string().optional(),
});
type StatusFile = z.infer<typeof statusFileSchema>;
export type NodeState = StatusFile["state"];

/** The launcher `start` ran: it leads a process group of its own, with the node it runs in it. */
const launcherFileSchema = z.object({ pid: z.number().int().positive(), started: z.string(), since: z.string() });
type LauncherFile = z.infer<typeof launcherFileSchema>;

/** The home's node as `status` sees it. */
export interface NodeStatus {
  /** What the node last recorded; `starting` while the launcher `start` ran has not yet started it. */
  state: NodeState | "starting";
  /** The node's pid; the launcher's while it has none running (`starting`, or restarting after `updating`). */
  pid: number;
  /** Whether it still runs: the node, or the launcher about to start it. */
  running: boolean;
  buildId?: string;
  serverUrl?: string;
  since: string;
  message?: string;
}

/** The node bundle this process runs from (`reins.js`), as its entry (`packages/cli/src/bundle/entry.ts`)
 * tells the commands it runs. */
export interface RunningBundle {
  path: string;
  /** Its sha256: the build ID. */
  buildId: string;
  /** Run by a launcher (`REINS_NODE_RESTART_EXIT_CODE`), which runs it again when it exits with
   * `RESTART_EXIT_CODE`. */
  restartable: boolean;
}

/** The bundle at `path`, hashed (streamed); `env` is the environment its process was given. */
export async function runningBundle(path: string, env: Env): Promise<RunningBundle> {
  return { path, buildId: await sha256File(path), restartable: env.REINS_NODE_RESTART_EXIT_CODE === String(RESTART_EXIT_CODE) };
}

/** What `installUpdate` reaches beyond the home. */
export interface UpdateDeps {
  /** `globalThis.fetch` by default. */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** This machine, for Bun's release (detected by default). */
  machine?: Machine;
  /** Extracts `entry` of the zip at `zip` into `dir`, flat (`unzip -qoj` by default). */
  unpack?: (zip: string, entry: string, dir: string) => Promise<void>;
}

/** What `start` does before it waits, as it does it. */
export type StartStep =
  /** A node of another build runs: it is stopped first. */
  | { step: "stopping"; pid: number; buildId?: string }
  /** It runs already (`thisBuild`: the build asked for); it is not started again. */
  | { step: "running"; pid: number; thisBuild: boolean }
  /** The launcher was started. */
  | { step: "launching" };

/** What starting the node came to. */
export type StartResult =
  | { outcome: "connected"; pid: number }
  | { outcome: "refused"; message?: string }
  /** It exited (or, not launched by this process, is not running) without connecting. */
  | { outcome: "exited"; exitCode: number | null }
  /** Still not connected after `afterMs`; `pid` when it still runs (it keeps trying). */
  | { outcome: "timeout"; afterMs: number; pid?: number }
  /** The node of another build did not stop within `afterMs`; nothing was started. */
  | { outcome: "not_stopped"; pid: number; afterMs: number };

export type StopResult = { outcome: "stopped"; pid: number } | { outcome: "not_running" } | { outcome: "timeout"; pid: number; afterMs: number };

/** Records the running node's state in the home's status file. */
export interface StatusRecorder {
  /** Writes a transition (a temp file renamed into place); after `refused` or `updating` nothing more. */
  set(state: Exclude<NodeState, "stopped">, message?: string): void;
  /** Records `stopped`, unless it was refused or is updating, which stay the final state. */
  stop(): void;
}

export class NodeInstall {
  /** The home's files named in what a command prints. */
  readonly paths: { readonly pairing: string; readonly launcher: string; readonly log: string };

  private constructor(readonly home: string) {
    this.paths = { pairing: join(home, "node.json"), launcher: join(home, "bin", "reins"), log: join(home, "logs", "node.log") };
  }

  /** The install in the home `env` names (`REINS_NODE_DATA_DIR`, default `~/.reins`). */
  static of(env: Env): NodeInstall {
    return new NodeInstall(env.REINS_NODE_DATA_DIR?.trim() || join(homedir(), ".reins"));
  }

  /** Whether a build was installed here: the launcher is there. */
  get installed(): boolean {
    return existsSync(this.paths.launcher);
  }

  /** How to run `reins` for this home, in hints: its launcher once installed. */
  command(): string {
    return this.installed ? this.paths.launcher : "reins";
  }

  // -- The pairing --------------------------------------------------------------------------------------

  /** The pairing, or null when there is none. Throws on a `node.json` that is not JSON or not of this version. */
  async pairing(): Promise<Pairing | null> {
    const path = this.paths.pairing;
    const file = Bun.file(path);
    if (!await file.exists()) return null;
    let json: unknown;
    try { json = JSON.parse(await file.text()); } catch { throw new Error(`Node config ${path} is not JSON`); }
    const version = typeof json === "object" && json !== null && "version" in json ? json.version : undefined;
    if (version !== PAIRING_VERSION) throw new Error(`Unsupported node config version ${String(version)} in ${path} (expected ${PAIRING_VERSION})`);
    const parsed = pairingSchema.safeParse(json);
    if (!parsed.success) throw new Error(`Invalid node config ${path}: ${z.prettifyError(parsed.error)}`);
    return parsed.data;
  }

  /** The paired node's key, as it dials its server (`connectNode`'s `key`): its private key and the
   * server's origin it signs for. */
  async key(pairing: Pairing): Promise<NodeKey> {
    const privateKey = createPrivateKey(await readFile(pairing.keyPath, "utf8"));
    if (privateKey.asymmetricKeyType !== "ed25519") throw new Error(`Node key ${pairing.keyPath} is not an Ed25519 key`);
    return { origin: new URL(pairing.serverUrl).origin, privateKey };
  }

  /**
   * Saves a new pairing: creates the home and `keys/` (0700), writes the private key to a new
   * `keys/<nodeId>.pem` (0600) and then `node.json` (0600, a temp file renamed into place), the commit point,
   * so a failure never leaves a pairing naming a missing or wrong key: the new key is removed again if
   * `node.json` is not written. The previous pairing's key, if there was one, is removed once the new
   * pairing is in place (an unreadable previous one is replaced all the same; only its key is left behind).
   */
  async savePairing({ serverUrl, nodeId, privateKey }: { serverUrl: string; nodeId: string; privateKey: KeyObject }): Promise<Pairing> {
    if (!nodeIdSchema.safeParse(nodeId).success) throw new Error("Node ID is not safe in a file name");
    const previous = await this.pairing().catch(() => null);
    const keysDir = join(this.home, "keys");
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    await mkdir(keysDir, { recursive: true, mode: 0o700 });
    const keyPath = join(keysDir, `${nodeId}.pem`);
    const pairing: Pairing = { version: PAIRING_VERSION, serverUrl, nodeId, keyPath };
    await writeFile(keyPath, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600, flag: "wx" });
    try {
      await replace(this.paths.pairing, temp => writeFile(temp, `${JSON.stringify(pairing, null, 2)}\n`, { mode: 0o600, flag: "wx" }));
    } catch (error) {
      await rm(keyPath, { force: true });
      throw error;
    }
    if (previous && previous.keyPath !== keyPath) await rm(previous.keyPath, { force: true });
    return pairing;
  }

  // -- Builds -------------------------------------------------------------------------------------------

  /**
   * Makes `bundle` the current build: it is put in `builds/<buildId>/reins.js` unless it runs from there or
   * that file already holds it (a copy renamed into place), `current` is flipped to it atomically (a new
   * symlink renamed over the old one), so the launcher always finds a whole build, and the launcher is
   * written: a few lines of sh with the home written in, which run the current build with
   * `REINS_NODE_DATA_DIR` set to the home and `REINS_NODE_RESTART_EXIT_CODE` to `RESTART_EXIT_CODE`, and run
   * it again whenever it exits with that code; any other exit is the launcher's. The same home writes the
   * same launcher.
   */
  async installBuild({ path, buildId }: Pick<RunningBundle, "path" | "buildId">): Promise<void> {
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    const dir = join(this.home, "builds", buildId);
    const installed = join(dir, "reins.js");
    const inPlace = await realpath(installed).then(target => realpath(path).then(own => own === target), () => false);
    if (!inPlace && await sha256File(installed).catch(() => null) !== buildId) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await replace(installed, temp => copyFile(path, temp));
    }
    await replace(join(this.home, "current"), temp => symlink(join("builds", buildId), temp));
    await mkdir(dirname(this.paths.launcher), { recursive: true, mode: 0o700 });
    await replace(this.paths.launcher, async temp => {
      await writeFile(temp, launcherScript(this.home), { mode: 0o755 });
      await chmod(temp, 0o755);
    });
  }

  /**
   * Installs the build an `update` reply names (ADR-025), so that the launcher runs it next: the bundle unless
   * `builds/<buildId>/reins.js` already holds it (streamed from `serverUrl` to a temporary file beside it,
   * checked against `update.sha256`, renamed into place); Bun `update.bunVersion` as the home's `bun` if this
   * process runs another (its official release for this machine, unpacked in a temporary directory and
   * checked to run as that version); then `installBuild`. Throws why it failed, leaving `current` and the
   * home's Bun as they were. It never blocks for long: a running node keeps its link alive meanwhile.
   */
  async installUpdate(serverUrl: string, update: BuildUpdate, deps: UpdateDeps = {}): Promise<void> {
    const fetch = deps.fetch ?? globalThis.fetch;
    const short = update.buildId.slice(0, 12);
    const server = serverUrl.replace(/\/+$/, "");
    if (update.sha256 !== update.buildId) throw new Error(`build ${short} from ${server} names another checksum than its build ID`);
    const dir = join(this.home, "builds", update.buildId);
    const bundle = join(dir, "reins.js");
    if (await sha256File(bundle).catch(() => null) !== update.sha256) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await replace(bundle, async temp => {
        const sha256 = await download(fetch, `${server}/nodes/builds/${update.buildId}/reins.js`, temp, `could not download build ${short} from ${server}`);
        if (sha256 !== update.sha256) throw new Error(`build ${short} from ${server} does not match its checksum`);
      });
    }
    if (update.bunVersion !== Bun.version) {
      await this.installBun(update.bunVersion, { fetch, machine: deps.machine ?? await thisMachine(), unpack: deps.unpack ?? unzip });
    }
    await this.installBuild({ path: bundle, buildId: update.buildId });
  }

  /** The build `current` names, or null when there is none. */
  async currentBuild(): Promise<string | null> {
    const target = await readlink(join(this.home, "current")).catch(() => null);
    return target === null ? null : basename(target);
  }

  private async installBun(version: string, { fetch, machine, unpack }: Required<UpdateDeps>): Promise<void> {
    const target = bunTarget(machine);
    const temp = await mkdtemp(join(this.home, "bun."));
    try {
      const zip = join(temp, "bun.zip");
      await download(fetch, `https://github.com/oven-sh/bun/releases/download/bun-v${version}/bun-${target}.zip`, zip, `could not download Bun ${version} for ${target} from GitHub`);
      await unpack(zip, `bun-${target}/bun`, temp);
      const bun = join(temp, "bun");
      await chmod(bun, 0o755);
      const ran = await run([bun, "--version"]).catch(() => null);
      if (ran?.exitCode !== 0 || ran.stdout.trim() !== version) throw new Error(`Bun ${version} for ${target} does not run on this machine`);
      await rename(bun, join(this.home, "bun"));
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }

  // -- The node in the background -----------------------------------------------------------------------

  /** The node, or null when none has run since the home's last `start` (nor ever in the foreground). */
  status(): NodeStatus | null {
    const { file, nodeAlive, launcher } = this.observe();
    if (!file) return launcher ? { state: "starting", pid: launcher.pid, since: launcher.since, running: true } : null;
    const { started: _started, ...status } = file;
    // Exited for its launcher to start the new build: the launcher is the node until that records itself.
    if (file.state === "updating" && !nodeAlive && launcher) return { ...status, pid: launcher.pid, running: true };
    return { ...status, running: nodeAlive };
  }

  /**
   * Starts the installed node in the background, unless it runs already, and waits until it connects, is
   * refused, exits or `CONNECT_TIMEOUT_MS` passes. Starting runs the launcher, `bin/reins node run`, as a
   * plain detached process (a process group of its own, stdin closed, output appended to `logs/node.log`,
   * cwd the home, `env` less what names the build that runs this: `withoutBundleEnv`) and records it: until
   * its node records itself, and while it restarts that node on a new build, it is what runs. Not a service:
   * nothing starts it after a reboot. With `replacingBuild`, a node running another build is stopped first.
   * `onStep` hears what it does before it waits.
   */
  async start(env: Env, { replacingBuild, onStep }: { replacingBuild?: string; onStep?: (step: StartStep) => void } = {}): Promise<StartResult> {
    const { file, nodeAlive, launcher } = this.observe();
    let pid = nodeAlive ? file?.pid : launcher?.pid;
    if (file && nodeAlive && replacingBuild && file.buildId !== replacingBuild) {
      onStep?.({ step: "stopping", pid: file.pid, ...(file.buildId ? { buildId: file.buildId } : {}) });
      const stopped = await this.stop();
      if (stopped.outcome === "timeout") return { outcome: "not_stopped", pid: file.pid, afterMs: stopped.afterMs };
      pid = undefined;
    }
    let launched: Launched | undefined;
    if (pid === undefined) {
      launched = this.launch(env);
      onStep?.({ step: "launching" });
    } else {
      onStep?.({ step: "running", pid, thisBuild: replacingBuild !== undefined });
    }
    return this.waitForConnection(launched, CONNECT_TIMEOUT_MS);
  }

  /**
   * Stops the node, if it runs, and waits up to `timeoutMs` for it, and its launcher, to exit: SIGTERM to
   * the node (it pauses its runs and exits, and its launcher with it), or, while its launcher runs no node
   * (starting one, or restarting it on a new build), to the launcher's process group.
   */
  async stop({ timeoutMs = STOP_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<StopResult> {
    const deadline = Date.now() + timeoutMs;
    const signalled = new Set<string>();
    let stopped: number | undefined;
    for (;;) {
      const { file, nodeAlive, launcher } = this.observe();
      const target = file && nodeAlive ? { pid: file.pid, kill: file.pid, key: `node ${file.pid} ${file.started}` }
        : launcher ? { pid: launcher.pid, kill: -launcher.pid, key: `launcher ${launcher.pid} ${launcher.started}` }
        : null;
      if (!target) return stopped === undefined ? { outcome: "not_running" } : { outcome: "stopped", pid: stopped };
      if (!signalled.has(target.key)) {
        signalled.add(target.key);
        stopped ??= target.pid;
        try { process.kill(target.kill, "SIGTERM"); } catch { /* exited meanwhile */ }
      }
      if (Date.now() >= deadline) return { outcome: "timeout", pid: stopped ?? target.pid, afterMs: timeoutMs };
      await Bun.sleep(POLL_MS);
    }
  }

  /**
   * Records this process as the home's node (`runInstalledNode`), or, while another node of the home runs (or its
   * launcher, other than this process's, is starting one), the pid of that one.
   */
  recorder(node: { serverUrl: string; buildId?: string }): { recorder: StatusRecorder } | { runningPid: number } {
    const { file, nodeAlive, launcher } = this.observe();
    if (file && nodeAlive && file.pid !== process.pid) return { runningPid: file.pid };
    if (!nodeAlive && launcher && launcher.pid !== process.ppid) return { runningPid: launcher.pid };
    const started = processStartTime(process.pid);
    if (started === null) throw new Error("Cannot tell when this process started");
    const path = this.statusPath;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    let current: NodeState | undefined;
    const set = (state: NodeState, message?: string) => {
      if (state === current || current === "refused" || current === "stopped" || current === "updating") return;
      current = state;
      const status: StatusFile = { pid: process.pid, started, state, ...(node.buildId ? { buildId: node.buildId } : {}), serverUrl: node.serverUrl, since: new Date().toISOString(), ...(message ? { message } : {}) };
      writeJson(path, status);
    };
    return { recorder: { set, stop: () => set("stopped") } };
  }

  private get statusPath(): string {
    return join(this.home, "run", "node-status.json");
  }

  private get launcherFilePath(): string {
    return join(this.home, "run", "launcher.json");
  }

  /** The status file, whether its node still runs, and the launcher `start` ran if it still runs. */
  private observe(): { file: StatusFile | null; nodeAlive: boolean; launcher: LauncherFile | null } {
    const file = readJson(this.statusPath, statusFileSchema);
    const launcher = readJson(this.launcherFilePath, launcherFileSchema);
    return { file, nodeAlive: file !== null && isAlive(file), launcher: launcher && isAlive(launcher) ? launcher : null };
  }

  /** Starts the launcher detached (see `start`), its node's previous status file removed first so that the
   * next one is this node's, and records it. */
  private launch(env: Env): Launched {
    rmSync(this.statusPath, { force: true });
    rmSync(this.launcherFilePath, { force: true });
    mkdirSync(dirname(this.paths.log), { recursive: true, mode: 0o700 });
    mkdirSync(dirname(this.launcherFilePath), { recursive: true, mode: 0o700 });
    const log = openSync(this.paths.log, "a", 0o600);
    let proc: Bun.Subprocess;
    try {
      proc = Bun.spawn([this.paths.launcher, "node", "run"], { cwd: this.home, env: withoutBundleEnv(env), stdin: "ignore", stdout: log, stderr: log, detached: true });
      proc.unref();
    } finally {
      closeSync(log);
    }
    const started = processStartTime(proc.pid);
    if (started !== null) writeJson(this.launcherFilePath, { pid: proc.pid, started, since: new Date().toISOString() } satisfies LauncherFile);
    return proc;
  }

  /** Waits until the node connects, is refused, or exits with its launcher, or `timeoutMs` passes. `launched`:
   * the launcher this process started, whose exit code it reports. */
  private async waitForConnection(launched: Launched | undefined, timeoutMs: number): Promise<StartResult> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { file, nodeAlive, launcher } = this.observe();
      if (file?.state === "refused") return { outcome: "refused", ...(file.message ? { message: file.message } : {}) };
      if (file && nodeAlive && file.state === "connected") return { outcome: "connected", pid: file.pid };
      if (!nodeAlive && !launcher && (!launched || launched.exitCode !== null)) return { outcome: "exited", exitCode: launched?.exitCode ?? null };
      const pid = nodeAlive ? file?.pid : launcher?.pid;
      if (Date.now() >= deadline) return { outcome: "timeout", afterMs: timeoutMs, ...(pid === undefined ? {} : { pid }) };
      await Bun.sleep(POLL_MS);
    }
  }
}

/** A launcher this process started. */
interface Launched {
  /** Its exit code once it has exited, else null. */
  readonly exitCode: number | null;
}

/** Named after the build's directory: another build started from this one must find its own. */
const BUILD_ENV = new Set(["PI_PACKAGE_DIR", "REINS_DOCS_DIR"]);

/**
 * What the node bundle's entry sets of `env` for itself, where unset (an empty value counts as unset), from
 * the directory `dir` it runs from, before any of Pi is evaluated: `PI_PACKAGE_DIR` to `dir`, so Pi does not
 * adopt the `package.json` of a directory above it; `PI_OFFLINE=1`, so Pi never installs the packages its
 * settings list; `REINS_DOCS_DIR` to `<dir>/docs`, where the entry writes the docs it carries. See
 * docs/dev/node-bundle.md *Running it*.
 */
export function applyBundleEnv(env: Env, dir: string): void {
  env.PI_PACKAGE_DIR ||= dir;
  env.PI_OFFLINE ||= "1";
  env.REINS_DOCS_DIR ||= join(dir, "docs");
}

/** `env` without what names the running build's directory (`applyBundleEnv`). */
function withoutBundleEnv(env: Env): Env {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !BUILD_ENV.has(name)));
}

/** Whether the process a file records still runs: its pid names a live process that started when it did. */
function isAlive(record: { pid: number; started: string }): boolean {
  return processStartTime(record.pid) === record.started;
}

function launcherScript(home: string): string {
  return `#!/bin/sh
# The Reins node launcher, written by \`reins node setup\`: runs the node home's current build, and runs it
# again when it exits with ${RESTART_EXIT_CODE} (a new build was made current). See docs/dev/node-bundle.md.
REINS_NODE_DATA_DIR=${shellQuote(home)}
REINS_NODE_RESTART_EXIT_CODE=${RESTART_EXIT_CODE}
export REINS_NODE_DATA_DIR REINS_NODE_RESTART_EXIT_CODE
while :; do
  "$REINS_NODE_DATA_DIR/bun" --no-install "$REINS_NODE_DATA_DIR/current/reins.js" "$@"
  status=$?
  [ "$status" -eq ${RESTART_EXIT_CODE} ] || exit "$status"
done
`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Puts a new file at `path` by writing it under a temporary name beside it (`write`) and renaming that
 * over `path`, so a reader sees the old one or the new one. */
async function replace(path: string, write: (temp: string) => Promise<void>): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await write(temp);
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/** A file's sha256, in hex, read as a stream. */
async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** Streams `url` to a new file `to` (0600); resolves with its sha256. Throws `failure` and why. */
async function download(fetch: NonNullable<UpdateDeps["fetch"]>, url: string, to: string, failure: string): Promise<string> {
  const failed = (error: unknown) => new Error(`${failure}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch (error) {
    throw failed(error);
  }
  if (!response.ok) throw new Error(`${failure}: HTTP ${response.status}`);
  const hash = createHash("sha256");
  const file = await open(to, "wx", 0o600);
  try {
    if (response.body) {
      for await (const chunk of response.body) {
        hash.update(chunk);
        await file.write(chunk);
      }
    }
  } catch (error) {
    throw failed(error);
  } finally {
    await file.close();
  }
  return hash.digest("hex");
}

/** A small JSON file, or null when there is none or it does not parse (a half-written one never exists:
 * `writeJson` renames it into place). */
function readJson<T>(path: string, schema: z.ZodType<T>): T | null {
  try {
    return schema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

function writeJson(path: string, value: unknown): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

/**
 * The node running on its own: `reins node run` records its pid and connection state in the node home's
 * status file (`run/node-status.json`), and `reins node start`/`stop`/`status` and `reins node setup` read
 * it to find, signal and wait for that process. Starting runs the launcher (install.ts) as a plain detached
 * process (a session of its own, stdin closed, output appended to `logs/node.log`): not a service, so
 * nothing starts it again after a reboot. See docs/dev/node-contract.md *Process model*.
 *
 * A status file outlives its process (a crash, a kill), and its pid may since name another process, so a
 * recorded pid is trusted, or signalled, only while that pid's start time is still the one recorded.
 */
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Env } from "../command.js";
import { launcherPath } from "./install.js";

const nodeStatusSchema = z.object({
  pid: z.number().int().positive(),
  /** When the process started, as the OS tells it (`processStartTime`): a pid reused by another process
   * has another. */
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
export type NodeStatus = z.infer<typeof nodeStatusSchema>;
export type NodeState = NodeStatus["state"];

/** How long `start` and `setup` wait for the node to connect. */
export const CONNECT_TIMEOUT_MS = 30_000;
/** How long `stop` waits for the node to exit: it pauses its runs (3 s) and closes them (5 s) first. */
export const STOP_TIMEOUT_MS = 15_000;
const POLL_MS = 100;

/** The variables a node bundle sets for itself (bundle/entry.ts): a node started by a bundle must not
 * inherit those of the build that started it. */
const BUNDLE_ENV = ["PI_PACKAGE_DIR", "REINS_DOCS_DIR"];

export function statusPath(home: string): string {
  return join(home, "run", "node-status.json");
}

export function logPath(home: string): string {
  return join(home, "logs", "node.log");
}

/** The status file, or null when there is none or it does not parse (a half-written file never exists:
 * it is renamed into place). */
export function readNodeStatus(home: string): NodeStatus | null {
  try {
    return nodeStatusSchema.parse(JSON.parse(readFileSync(statusPath(home), "utf8")));
  } catch {
    return null;
  }
}

/** Whether the process `status` records is still running: its pid names a live process that started
 * when it did. */
export function isRunning(status: NodeStatus): boolean {
  return processStartTime(status.pid) === status.started;
}

/** The node running in this home: its status, if its process is still running. */
export function runningNode(home: string): NodeStatus | null {
  const status = readNodeStatus(home);
  return status && isRunning(status) ? status : null;
}

/** Records this process as the home's node: `set` writes each transition (a temp file renamed into place),
 * and `stop` the final `stopped`, unless it was refused or is updating, which stay the final state. */
export function nodeStatusRecorder(home: string, node: { serverUrl: string; buildId?: string }): { set(state: NodeState, message?: string): void; stop(): void } {
  const started = processStartTime(process.pid);
  if (started === null) throw new Error("Cannot tell when this process started");
  mkdirSync(join(home, "run"), { recursive: true, mode: 0o700 });
  let current: NodeState | undefined;
  const set = (state: NodeState, message?: string) => {
    if (state === current || current === "refused" || current === "stopped" || current === "updating") return;
    current = state;
    const status: NodeStatus = { pid: process.pid, started, state, ...(node.buildId ? { buildId: node.buildId } : {}), serverUrl: node.serverUrl, since: new Date().toISOString(), ...(message ? { message } : {}) };
    const path = statusPath(home);
    const temp = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temp, `${JSON.stringify(status)}\n`, { mode: 0o600 });
    renameSync(temp, path);
  };
  return { set, stop: () => set("stopped") };
}

/** A node started in the background: the launcher's process. */
export interface LaunchedNode {
  /** The launcher's pid (the node is its child). */
  readonly pid: number;
  /** Its exit code once it has exited, else null. */
  readonly exitCode: number | null;
}

/**
 * Starts `bin/reins node run` detached, its output appended to `logs/node.log`, with `env` (less what a
 * bundle set for itself). The node's previous status file is removed first, so the next one is this
 * node's. Check that no node is running first (`runningNode`).
 */
export function launchNode(home: string, env: Env): LaunchedNode {
  rmSync(statusPath(home), { force: true });
  mkdirSync(join(home, "logs"), { recursive: true, mode: 0o700 });
  const log = openSync(logPath(home), "a", 0o600);
  try {
    const childEnv = Object.fromEntries(Object.entries(env).filter(([name]) => !BUNDLE_ENV.includes(name)));
    const proc = Bun.spawn([launcherPath(home), "node", "run"], { cwd: home, env: childEnv, stdin: "ignore", stdout: log, stderr: log, detached: true });
    proc.unref();
    return proc;
  } finally {
    closeSync(log);
  }
}

/** What waiting for a node to connect came to. */
export type ConnectResult =
  | { outcome: "connected"; status: NodeStatus }
  | { outcome: "refused"; status: NodeStatus }
  /** It exited (or, not launched by this process, is not running) without connecting. */
  | { outcome: "exited"; exitCode: number | null }
  /** Still not connected at the timeout; it may still be trying. */
  | { outcome: "timeout"; status: NodeStatus | null };

/** Waits until the home's node connects, is refused or exits, or `timeoutMs` passes. `launched`: the
 * launcher this process started, whose exit ends the wait. */
export async function waitForConnection(home: string, { launched, timeoutMs = CONNECT_TIMEOUT_MS }: { launched?: LaunchedNode; timeoutMs?: number } = {}): Promise<ConnectResult> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = readNodeStatus(home);
    if (status?.state === "refused") return { outcome: "refused", status };
    if (status && isRunning(status)) {
      if (status.state === "connected") return { outcome: "connected", status };
    } else if (!launched || launched.exitCode !== null) {
      return { outcome: "exited", exitCode: launched?.exitCode ?? null };
    }
    if (Date.now() >= deadline) return { outcome: "timeout", status };
    await Bun.sleep(POLL_MS);
  }
}

export type StopResult = { outcome: "stopped"; status: NodeStatus } | { outcome: "not_running" } | { outcome: "timeout"; status: NodeStatus };

/** Sends SIGTERM to the home's node, if it is running, and waits up to `timeoutMs` for it to exit. */
export async function stopNode(home: string, timeoutMs = STOP_TIMEOUT_MS): Promise<StopResult> {
  const status = runningNode(home);
  if (!status) return { outcome: "not_running" };
  try {
    process.kill(status.pid, "SIGTERM");
  } catch {
    return { outcome: "not_running" };
  }
  const deadline = Date.now() + timeoutMs;
  while (isRunning(status)) {
    if (Date.now() >= deadline) return { outcome: "timeout", status };
    await Bun.sleep(POLL_MS);
  }
  return { outcome: "stopped", status };
}

/**
 * When process `pid` started, as an opaque string, or null when no such process is running (a zombie
 * counts as gone). Linux: `/proc/<pid>/stat`'s start time (clock ticks since boot); elsewhere (macOS):
 * `ps -o lstart=`.
 */
export function processStartTime(pid: number): string | null {
  let stat: string | undefined;
  try { stat = readFileSync(`/proc/${pid}/stat`, "utf8"); } catch { /* not Linux, or no such process */ }
  if (stat !== undefined) {
    // After the command name (in parentheses, which may hold anything): the state, then fields 4 on;
    // the start time is field 22.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[0] === "Z" || fields[0] === "X" ? null : fields[19] ?? null;
  }
  if (process.platform === "linux") return null;
  const ps = Bun.spawnSync(["ps", "-o", "stat=,lstart=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
  const line = ps.stdout.toString().trim();
  if (ps.exitCode !== 0 || line === "" || line.startsWith("Z")) return null;
  return line.slice(line.indexOf(" ") + 1).trim();
}

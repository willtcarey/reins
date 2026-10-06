/**
 * Process supervisor for normal use: `bun run start` (server + node) and `bun run dev` (server with
 * handler hot reload + node + frontend watchers). The server and the node are separate processes that
 * meet on the local node socket (`REINS_NODE_SOCKET`, default `~/.reins/run/node.sock`; both inherit it).
 *
 * - The server exiting stops everything (exit with its code).
 * - The node exiting unexpectedly is restarted with exponential backoff (1 s doubling to 30 s, reset
 *   once it has stayed up 30 s); it reconnects and replays its outbox. Nothing watches node code, in
 *   `dev` either. The node is told `NODE_RELOAD_EXIT_CODE` (`REINS_NODE_RELOAD_EXIT_CODE`): it exits
 *   with it for an explicit `node.reload`, and is started again at once on its new code (see
 *   docs/dev/hot-reload.md).
 * - Frontend watchers restart after 1 s.
 * - SIGTERM/SIGINT: SIGTERM every child (the node pauses its runs for the next node to resume), SIGKILL
 *   whatever is still running after CHILD_STOP_TIMEOUT_MS, exit 0.
 *
 * Imports nothing from the server or the node: it only spawns them.
 */
import { join } from "path";

const FRONTEND_PACKAGE_DIR = "packages/frontend";
const FRONTEND_ENTRYPOINTS = [
  "src/index.ts",
  "src/models/changes/highlight-worker.ts",
];
const FRONTEND_DIST_DIR = "dist";
const FRONTEND_CSS_INPUT = "src/components/app.css";
const FRONTEND_CSS_OUTPUT = "dist/app.css";
const SERVER_ENTRYPOINT = "packages/backend/src/index.ts";
const SERVER_DEV_ENTRYPOINT = "packages/backend/dev.ts";
const NODE_ENTRYPOINT = "packages/node/src/main.ts";
/** Longer than the node's own shutdown bounds (3 s pausing runs, 5 s closing them). */
const CHILD_STOP_TIMEOUT_MS = 10_000;

export interface Backoff { initialMs: number; maxMs: number; /** Uptime after which the delay resets. */ resetAfterMs: number }
const WATCHER_RESTART: Backoff = { initialMs: 1_000, maxMs: 1_000, resetAfterMs: 0 };
export const NODE_RESTART: Backoff = { initialMs: 1_000, maxMs: 30_000, resetAfterMs: 30_000 };
/** The node exits with this code to be restarted at once: an explicit reload (EX_TEMPFAIL). */
export const NODE_RELOAD_EXIT_CODE = 75;

export interface Service {
  name: string;
  command: string[];
  cwd: string;
  env?: Record<string, string>;
  /** `stop-all`: its exit stops every service. Otherwise it is restarted after the backoff, or at once
   * (not counted as a failure) when it exits with `immediatelyOn`. */
  onExit: "stop-all" | { restart: Backoff; immediatelyOn?: number };
}

export type SupervisorMode = "start" | "dev";

export function createServices(mode: SupervisorMode, repoRoot = process.cwd()): Service[] {
  const bun = process.execPath;
  const core: Service[] = [
    mode === "dev"
      ? { name: "server", cwd: repoRoot, onExit: "stop-all", command: [bun, SERVER_DEV_ENTRYPOINT] }
      : { name: "server", cwd: repoRoot, onExit: "stop-all", command: [bun, SERVER_ENTRYPOINT] },
    {
      name: "node", cwd: repoRoot, command: [bun, NODE_ENTRYPOINT],
      onExit: { restart: NODE_RESTART, immediatelyOn: NODE_RELOAD_EXIT_CODE },
      env: { REINS_NODE_RELOAD_EXIT_CODE: String(NODE_RELOAD_EXIT_CODE) },
    },
  ];
  if (mode === "start") return core;
  const frontendRoot = join(repoRoot, FRONTEND_PACKAGE_DIR);
  return [
    {
      name: "frontend:bundle",
      cwd: frontendRoot,
      onExit: { restart: WATCHER_RESTART },
      env: { REINS_DEV: "1" },
      command: [bun, "build", ...FRONTEND_ENTRYPOINTS, "--outdir", FRONTEND_DIST_DIR, "--splitting", "--define", "REINS_DEV=true", "--watch"],
    },
    {
      name: "frontend:css",
      cwd: frontendRoot,
      onExit: { restart: WATCHER_RESTART },
      command: [bun, "node_modules/.bin/tailwindcss", "-i", FRONTEND_CSS_INPUT, "-o", FRONTEND_CSS_OUTPUT, "--watch=always"],
    },
    ...core,
  ];
}

type Child = ReturnType<typeof Bun.spawn>;

export async function runSupervisor(services: Service[], label: string): Promise<number> {
  const log = (message: string) => process.stderr.write(`[${label}] ${message}\n`);
  const running = new Map<string, Child>();
  const restartTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const failures = new Map<string, number>();
  let stopping = false;
  let finish!: (code: number) => void;
  const done = new Promise<number>(resolve => { finish = resolve; });

  const shutdown = (code: number): void => {
    if (stopping) return;
    stopping = true;
    for (const timer of restartTimers.values()) clearTimeout(timer);
    restartTimers.clear();
    void stopChildren(running).then(() => finish(code));
  };

  const scheduleRestart = (service: Service, backoff: Backoff, uptimeMs: number): void => {
    const previous = uptimeMs >= backoff.resetAfterMs ? 0 : failures.get(service.name) ?? 0;
    failures.set(service.name, previous + 1);
    const delay = Math.min(backoff.maxMs, backoff.initialMs * 2 ** previous);
    log(`${service.name} restarting in ${delay}ms`);
    restartTimers.set(service.name, setTimeout(() => {
      restartTimers.delete(service.name);
      if (!stopping) start(service);
    }, delay));
  };

  function start(service: Service): void {
    const startedAt = Date.now();
    let child: Child;
    try {
      child = Bun.spawn({
        cmd: service.command,
        cwd: service.cwd,
        env: { ...process.env, ...service.env },
        stdout: "inherit",
        stderr: "inherit",
      });
    } catch (error) {
      log(`${service.name} failed to start: ${String(error)}`);
      if (service.onExit === "stop-all") shutdown(1);
      else scheduleRestart(service, service.onExit.restart, 0);
      return;
    }
    running.set(service.name, child);
    log(`started ${service.name} (pid ${child.pid}): ${formatCommand(service.command)}`);
    void child.exited.then(code => {
      if (running.get(service.name) !== child) return;
      running.delete(service.name);
      if (stopping) return;
      log(`${service.name} exited with code ${code}`);
      if (service.onExit === "stop-all") { log("stopping all services"); shutdown(code || 1); return; }
      if (code === service.onExit.immediatelyOn) { log(`${service.name} reloading`); failures.delete(service.name); start(service); return; }
      scheduleRestart(service, service.onExit.restart, Date.now() - startedAt);
    });
  }

  const onSignal = (signal: string) => () => {
    if (stopping) return;
    log(`received ${signal}; stopping all services`);
    shutdown(0);
  };
  const handleSigint = onSignal("SIGINT");
  const handleSigterm = onSignal("SIGTERM");
  process.on("SIGINT", handleSigint);
  process.on("SIGTERM", handleSigterm);

  for (const service of services) {
    if (stopping) break;
    start(service);
  }

  const code = await done;
  process.removeListener("SIGINT", handleSigint);
  process.removeListener("SIGTERM", handleSigterm);
  return code;
}

function formatCommand(command: string[]): string {
  return command.map(part => (part.includes(" ") ? JSON.stringify(part) : part)).join(" ");
}

async function stopChildren(running: Map<string, Child>): Promise<void> {
  const children = [...running.values()];
  running.clear();
  for (const child of children) child.kill("SIGTERM");
  const exited = Promise.all(children.map(child => child.exited.catch(() => 1)));
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>(resolve => {
    killTimer = setTimeout(() => {
      for (const child of children) child.kill("SIGKILL");
      resolve();
    }, CHILD_STOP_TIMEOUT_MS);
  });
  await Promise.race([exited, timeout]);
  if (killTimer) clearTimeout(killTimer);
}

if (import.meta.main) {
  const mode = process.argv[2];
  if (mode !== "start" && mode !== "dev") {
    process.stderr.write("Usage: bun packages/backend/src/supervisor.ts <start|dev>\n");
    process.exit(2);
  }
  process.exit(await runSupervisor(createServices(mode), mode));
}

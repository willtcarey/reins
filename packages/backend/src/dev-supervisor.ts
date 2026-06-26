import { join } from "path";

const FRONTEND_PACKAGE_DIR = "packages/frontend";
const FRONTEND_ENTRYPOINTS = [
  "src/index.ts",
  "src/models/changes/highlight-worker.ts",
];
const FRONTEND_DIST_DIR = "dist";
const FRONTEND_CSS_INPUT = "src/components/app.css";
const FRONTEND_CSS_OUTPUT = "dist/app.css";
const BACKEND_DEV_ENTRYPOINT = "packages/backend/dev.ts";
const RESTART_DELAY_MS = 1_000;
const CHILD_STOP_TIMEOUT_MS = 2_000;

type DevChild = ReturnType<typeof Bun.spawn>;

interface DevService {
  name: string;
  command: string[];
  cwd: string;
  restart: boolean;
}

function createDevServices(repoRoot = process.cwd()): DevService[] {
  const frontendRoot = join(repoRoot, FRONTEND_PACKAGE_DIR);

  return [
    {
      name: "frontend:bundle",
      cwd: frontendRoot,
      restart: true,
      command: [
        "bun",
        "build",
        ...FRONTEND_ENTRYPOINTS,
        "--outdir",
        FRONTEND_DIST_DIR,
        "--splitting",
        "--define",
        "REINS_DEV=true",
        "--watch",
      ],
    },
    {
      name: "frontend:css",
      cwd: frontendRoot,
      restart: true,
      command: [
        "bun",
        "node_modules/.bin/tailwindcss",
        "-i",
        FRONTEND_CSS_INPUT,
        "-o",
        FRONTEND_CSS_OUTPUT,
        "--watch=always",
      ],
    },
    {
      name: "backend",
      cwd: repoRoot,
      restart: false,
      command: ["bun", BACKEND_DEV_ENTRYPOINT],
    },
  ];
}

async function runDevSupervisor(): Promise<number> {
  const services = createDevServices();
  const running = new Map<string, DevChild>();
  const restartTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let stopping = false;
  let finish: ((code: number) => void) | undefined;
  let finished = false;

  const done = new Promise<number>((resolve) => {
    finish = resolve;
  });

  const resolveDone = (code: number): void => {
    if (finished) return;
    finished = true;
    finish?.(code);
  };

  const scheduleRestart = (service: DevService): void => {
    const timer = setTimeout(() => {
      restartTimers.delete(service.name);
      if (!stopping) startService(service);
    }, RESTART_DELAY_MS);
    restartTimers.set(service.name, timer);
  };

  const shutdown = (code: number): void => {
    if (stopping) return;
    stopping = true;
    for (const timer of restartTimers.values()) clearTimeout(timer);
    restartTimers.clear();
    void stopChildren(running).then(() => resolveDone(code));
  };

  const handleServiceExit = (service: DevService, child: DevChild, code: number): void => {
    if (running.get(service.name) !== child) return;
    running.delete(service.name);

    if (stopping) return;

    if (service.restart) {
      writeSupervisorLog(`${service.name} exited with code ${code}; restarting in ${RESTART_DELAY_MS}ms`);
      scheduleRestart(service);
      return;
    }

    writeSupervisorLog(`${service.name} exited with code ${code}; stopping dev services`);
    shutdown(code);
  };

  const handleStartFailure = (service: DevService, error: unknown): void => {
    writeSupervisorLog(`${service.name} failed to start: ${String(error)}`);
    if (service.restart && !stopping) {
      writeSupervisorLog(`${service.name} will retry in ${RESTART_DELAY_MS}ms`);
      scheduleRestart(service);
      return;
    }
    shutdown(1);
  };

  function startService(service: DevService): void {
    writeSupervisorLog(`starting ${service.name}: ${formatCommand(service.command)}`);

    try {
      const child = Bun.spawn({
        cmd: service.command,
        cwd: service.cwd,
        env: process.env,
        stdout: "inherit",
        stderr: "inherit",
      });

      running.set(service.name, child);
      void child.exited.then(
        (code) => handleServiceExit(service, child, code),
        (error) => handleStartFailure(service, error),
      );
    } catch (error) {
      handleStartFailure(service, error);
    }
  }

  const handleSigint = (): void => {
    if (stopping) return;
    writeSupervisorLog("received SIGINT; stopping dev services");
    shutdown(130);
  };
  const handleSigterm = (): void => {
    if (stopping) return;
    writeSupervisorLog("received SIGTERM; stopping dev services");
    shutdown(143);
  };

  process.on("SIGINT", handleSigint);
  process.on("SIGTERM", handleSigterm);

  for (const service of services) {
    if (stopping) break;
    startService(service);
  }

  const code = await done;
  process.removeListener("SIGINT", handleSigint);
  process.removeListener("SIGTERM", handleSigterm);
  return code;
}

function formatCommand(command: string[]): string {
  return command.map((part) => (part.includes(" ") ? JSON.stringify(part) : part)).join(" ");
}

function writeSupervisorLog(message: string): void {
  process.stderr.write(`[dev] ${message}\n`);
}

async function stopChildren(running: Map<string, DevChild>): Promise<void> {
  const children = [...running.values()];
  running.clear();

  for (const child of children) child.kill("SIGTERM");

  const exited = Promise.all(children.map((child) => child.exited.catch(() => 1)));
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    killTimer = setTimeout(() => {
      for (const child of children) child.kill("SIGKILL");
      resolve();
    }, CHILD_STOP_TIMEOUT_MS);
  });

  await Promise.race([exited, timeout]);
  if (killTimer) clearTimeout(killTimer);
}

if (import.meta.main) {
  const code = await runDevSupervisor();
  process.exit(code);
}

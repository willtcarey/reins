import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServices, NODE_RELOAD_EXIT_CODE, NODE_RESTART, runSupervisor, type Service } from "../supervisor.js";
import { Child, createProcessLayout, DEV_SUPERVISOR_ENTRY, FAUX_PROVIDER, NODE_ENTRY, ServerApi, SUPERVISOR_ENTRY, until, type ProcessLayout } from "./helpers/processes.js";

const cleanups: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).toReversed()) await cleanup(); });

test("start and dev both run the server and a node restarted when it exits; only the dev node reloads on code changes, restarted at once on its reload exit", () => {
  for (const mode of ["start", "dev"] as const) {
    const services = createServices(mode, "/repo");
    const server = services.find(service => service.name === "server")!;
    const node = services.find(service => service.name === "node")!;
    expect(server.onExit).toBe("stop-all");
    expect(server.command.at(-1)).toBe(mode === "dev" ? "packages/backend/dev.ts" : "packages/backend/src/index.ts");
    expect(node.command).toEqual([process.execPath, "packages/node/src/main.ts"]);
    if (mode === "dev") {
      expect(node.onExit).toEqual({ restart: NODE_RESTART, reloadExitCode: NODE_RELOAD_EXIT_CODE });
      expect(node.env).toEqual({ REINS_NODE_DEV_RELOAD: "1" });
    } else {
      expect(node.onExit).toEqual({ restart: NODE_RESTART });
      expect(node.env).toBeUndefined();
    }
  }
  expect(createServices("start", "/repo").map(service => service.name)).toEqual(["server", "node"]);
});

test("a service exiting with its reload code is restarted at once, however often; a crash waits for the backoff", async () => {
  const root = mkdtempSync(join(tmpdir(), "reins-supervisor-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const bun = process.execPath;
  // Each start appends a line; the first three exit with `code`, the fourth stays up.
  const flaky = (name: string, code: number): Service => ({
    name, cwd: root, onExit: { restart: { initialMs: 1_000, maxMs: 30_000, resetAfterMs: 30_000 }, reloadExitCode: NODE_RELOAD_EXIT_CODE },
    command: [bun, "-e", `import { appendFileSync, readFileSync } from "node:fs"; appendFileSync("${name}", "x"); if (readFileSync("${name}", "utf8").length < 4) process.exit(${code}); await Bun.sleep(60_000);`],
  });
  const main: Service = { name: "main", cwd: root, onExit: "stop-all", command: [bun, "-e", "await Bun.sleep(2_500)"] };
  expect(await runSupervisor([flaky("reloading", NODE_RELOAD_EXIT_CODE), flaky("crashing", 1), main], "test")).toBe(1);
  expect(readFileSync(join(root, "reloading"), "utf8")).toBe("xxxx");
  // Started, crashed, restarted after 1 s, crashed, next restart due after 3 s: past main's exit.
  expect(readFileSync(join(root, "crashing"), "utf8")).toBe("xx");
}, 20_000);

test("the start supervisor launches server and node, restarts a crashed node with backoff, does not restart it when node code changes, and stops both on SIGTERM", async () => {
  const dirs: ProcessLayout = await createProcessLayout();
  cleanups.push(() => dirs.dispose());
  const home = join(dirs.root, "home");
  mkdirSync(home);
  const supervisor = new Child("supervisor", [process.execPath, SUPERVISOR_ENTRY, "start"], {
    cwd: new URL("../../../../", import.meta.url).pathname,
    env: { ...process.env, NODE_ENV: "production", REINS_DEV: "0", REINS_PORT: "0", HOME: home, REINS_DATA_DIR: dirs.dataDir,
      REINS_NODE_SOCKET: dirs.socket, REINS_NODE_TEST_FAUX_PROVIDER: FAUX_PROVIDER },
  });
  cleanups.push(() => supervisor.stop("SIGKILL"));
  const [, port] = await supervisor.waitFor(/listening on http:\/\/localhost:(\d+)/);
  await supervisor.waitFor(/\[node\] connected to server/);
  const api = new ServerApi(Number(port));
  expect(await api.localNodeConnected()).toBe(true);

  // A crashed node is restarted and reconnects.
  const [, pid] = await supervisor.waitFor(/started node \(pid (\d+)\)/);
  process.kill(Number(pid), "SIGKILL");
  await supervisor.waitFor(/node exited with code \d+/);
  await supervisor.waitFor(new RegExp(`node restarting in ${NODE_RESTART.initialMs}ms`));
  await supervisor.waitFor(/started node \(pid (\d+)\)/, 2);
  await supervisor.waitFor(/\[node\] connected to server/, 2);
  await until(() => api.localNodeConnected(), "node reconnected");

  // In start, node code changes do not restart a running node (dev reload is dev only).
  writeFileSync(NODE_ENTRY, readFileSync(NODE_ENTRY));
  await Bun.sleep(1_500);
  expect(supervisor.count(/started node \(pid/)).toBe(2);

  // SIGTERM stops both children and exits cleanly.
  expect(await supervisor.stop("SIGTERM")).toBe(0);
  await Bun.sleep(100); // drain piped output
  expect(supervisor.output).toContain("received SIGTERM; stopping all services");
  expect(supervisor.output).toContain("[node] stopped");
  expect(supervisor.output).toContain("Received SIGTERM; shutting down");
  expect(existsSync(dirs.socket)).toBe(false);
}, 60_000);

test("in dev, a node code change reloads the node only once it is idle: the active run completes, the supervisor restarts the node at once, and input queued during the restart is delivered once", async () => {
  const dirs: ProcessLayout = await createProcessLayout();
  cleanups.push(() => dirs.dispose());
  const home = join(dirs.root, "home");
  const watched = join(dirs.root, "node-src");
  for (const dir of [home, watched]) mkdirSync(dir);
  const supervisor = new Child("supervisor", [process.execPath, DEV_SUPERVISOR_ENTRY], {
    cwd: dirs.nodeCwd,
    env: { ...process.env, NODE_ENV: "production", REINS_PORT: "0", HOME: home, REINS_DATA_DIR: dirs.dataDir, REINS_NODE_SOCKET: dirs.socket,
      REINS_NODE_TEST_FAUX_PROVIDER: FAUX_PROVIDER, REINS_NODE_DEV_WATCH_DIR: watched },
  });
  cleanups.push(() => supervisor.stop("SIGKILL"));
  const [, port] = await supervisor.waitFor(/listening on http:\/\/localhost:(\d+)/);
  await supervisor.waitFor(/\[node\] dev reload: watching/);
  await supervisor.waitFor(/\[node\] connected to server/);
  const api = new ServerApi(Number(port));
  const { projectId } = await api.setUp(dirs.repo.dir);
  const sessionId = await api.createSession(projectId);
  await api.prompt(sessionId, "first", "One");
  await api.waitForTranscript(sessionId, ["user: One", "assistant: Echo: One"]);

  // A node source changes while a run is active: the node waits for it.
  await api.prompt(sessionId, "slow", "Two [slow:2500]");
  await api.waitForTranscript(sessionId, ["user: Two [slow:2500]"]);
  writeFileSync(join(watched, "changed.ts"), "export {};\n");
  await supervisor.waitFor(/\[node\] code changed \(changed\.ts\); waiting for 1 active run before reloading/);
  expect(supervisor.count(/node reloading after code change/)).toBe(0);

  // Once the run has settled the node reloads: a clean stop with the reload exit code.
  await supervisor.waitFor(/\[node\] node reloading after code change \(changed\.ts\)/);
  // Queued while the node restarts.
  await api.prompt(sessionId, "during", "Three");
  await supervisor.waitFor(/\[node\] stopped for reload/);
  await supervisor.waitFor(new RegExp(`node exited with code ${NODE_RELOAD_EXIT_CODE}`));
  await supervisor.waitFor(/node restarting now to reload/);
  await supervisor.waitFor(/started node \(pid (\d+)\)/, 2);
  await supervisor.waitFor(/\[node\] connected to server/, 2);

  const transcript = await api.waitForTranscript(sessionId, ["user: Three", "assistant: Echo: Three"], 30_000);
  expect(transcript).toEqual(["user: One", "assistant: Echo: One", "user: Two [slow:2500]", "assistant: Echo: Two [slow:2500]", "user: Three", "assistant: Echo: Three"]);
  await until(async () => await api.activity(sessionId) === "finished", "settled");
  expect(supervisor.count(/node restarting in/)).toBe(0);
  expect(supervisor.count(/\[node\] received/)).toBe(0);

  expect(await supervisor.stop("SIGTERM")).toBe(0);
}, 90_000);

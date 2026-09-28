import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServices, NODE_RESTART } from "../supervisor.js";
import { Child, createProcessLayout, FAUX_PROVIDER, NODE_ENTRY, ServerApi, SUPERVISOR_ENTRY, until, type ProcessLayout } from "./helpers/processes.js";

const cleanups: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).toReversed()) await cleanup(); });

test("start and dev both run the server and a node that is restarted only when it exits, never watched for code changes", () => {
  for (const mode of ["start", "dev"] as const) {
    const services = createServices(mode, "/repo");
    const server = services.find(service => service.name === "server")!;
    const node = services.find(service => service.name === "node")!;
    expect(server.onExit).toBe("stop-all");
    expect(server.command.at(-1)).toBe(mode === "dev" ? "packages/backend/dev.ts" : "packages/backend/src/index.ts");
    expect(node.command).toEqual([process.execPath, "packages/node/src/main.ts"]);
    expect(node.onExit).toEqual({ restart: NODE_RESTART });
    expect(node.env).toBeUndefined();
  }
  expect(createServices("start", "/repo").map(service => service.name)).toEqual(["server", "node"]);
});

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

  // Node code changes do not restart a running node.
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

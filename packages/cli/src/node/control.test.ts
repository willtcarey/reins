import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateNodeKeyPair } from "@reins/node-protocol";
import { lastLine, reins } from "../testing/reins.js";
import { NodeInstall, runningBundle } from "@reins/node/install";

const INSTALL = Bun.resolveSync("@reins/node/install", import.meta.dir);

const temps: string[] = [];
const installs: NodeInstall[] = [];
const children: Bun.Subprocess[] = [];
afterEach(async () => {
  for (const install of installs.splice(0)) await install.stop({ timeoutMs: 5_000 });
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}

/** A node home paired with http://reins.test, with nothing installed. */
async function pairedHome() {
  const home = tempDir("reins-node-control-");
  const install = NodeInstall.of({ REINS_NODE_DATA_DIR: home });
  installs.push(install);
  await install.savePairing({ serverUrl: "http://reins.test", nodeId: "laptop", privateKey: generateNodeKeyPair().privateKey });
  return { home, install, env: { REINS_NODE_DATA_DIR: home, PATH: process.env.PATH } };
}

test("start refuses a node that was not installed: there is no launcher; run it in the foreground", async () => {
  const { home, env } = await pairedHome();

  const run = await reins(["node", "start"], env);

  expect({ exitCode: run.exitCode, last: lastLine(run.stderr) }).toEqual({
    exitCode: 1, last: `Not started: this node was not installed (no ${join(home, "bin", "reins")}). Run it in the foreground instead: reins node run`,
  });
});

/** A status file left by a node that is gone, whose pid another process now has. */
function foreignStatusFile(home: string, pid: number) {
  mkdirSync(join(home, "run"));
  writeFileSync(join(home, "run", "node-status.json"), JSON.stringify({ pid, started: "1", state: "connected", serverUrl: "http://reins.test", since: "2026-10-10T06:00:00.000Z" }));
}

test("a status file whose pid now names another process is not trusted: status says not running and stop signals nothing", async () => {
  const { home, env } = await pairedHome();
  // A live process under the recorded pid, but not the one that wrote it: it started at another time.
  const other = Bun.spawn(["sleep", "30"]);
  children.push(other);
  foreignStatusFile(home, other.pid);

  const status = await reins(["node", "status"], env);
  const stop = await reins(["node", "stop"], env);

  expect({ exitCode: status.exitCode, last: lastLine(status.stdout) }).toEqual({ exitCode: 3, last: "Not running (last connected at 2026-10-10T06:00:00.000Z). Start it: reins node start" });
  expect({ exitCode: stop.exitCode, last: lastLine(stop.stdout) }).toEqual({ exitCode: 0, last: "Node not running." });
  await Bun.sleep(100);
  expect({ exitCode: other.exitCode, signalCode: other.signalCode }).toEqual({ exitCode: null, signalCode: null });
});

/**
 * Installs, as the home's build, a stand-in node that records itself as `reins node run` does and updates
 * once: its first run connects, and once `update` exists in `dir` records `updating` and exits for its
 * launcher; its next run waits for `release` there before it connects. Every run appends its pid to
 * `dir/runs`. SIGTERM stops it.
 */
async function installUpdatingNode(install: NodeInstall, home: string) {
  const dir = tempDir("reins-node-control-stub-");
  symlinkSync(process.execPath, join(home, "bun"));
  const path = join(dir, "reins.js");
  writeFileSync(path, `
    import { appendFileSync, existsSync, readFileSync } from "node:fs";
    import { NodeInstall, RESTART_EXIT_CODE } from ${JSON.stringify(INSTALL)};
    const dir = ${JSON.stringify(dir)};
    const waitFor = async name => { while (!existsSync(dir + "/" + name)) await Bun.sleep(20); };
    appendFileSync(dir + "/runs", process.pid + "\\n");
    const first = readFileSync(dir + "/runs", "utf8").trim().split("\\n").length === 1;
    const claim = NodeInstall.of(process.env).recorder({ serverUrl: "http://reins.test" });
    if (!claim.recorder) process.exit(1);
    const status = claim.recorder;
    process.on("SIGTERM", () => { status.stop(); process.exit(0); });
    if (first) {
      status.set("connected");
      await waitFor("update");
      status.set("updating");
      process.exit(RESTART_EXIT_CODE);
    }
    await waitFor("release");
    status.set("connected");
    setInterval(() => {}, 1000);
  `);
  await install.installBuild(await runningBundle(path, {}));
  return {
    runs: () => readFileSync(join(dir, "runs"), "utf8").trim().split("\n").map(Number),
    update: () => writeFileSync(join(dir, "update"), ""),
    release: () => writeFileSync(join(dir, "release"), ""),
  };
}

async function until(condition: () => boolean, what: string) {
  for (let i = 0; i < 200 && !condition(); i++) await Bun.sleep(25);
  if (!condition()) throw new Error(`Timed out waiting until ${what}`);
}

test("while its launcher restarts the node on a new build, status says so and start starts no second node: it waits for the new build to connect", async () => {
  const { home, install, env } = await pairedHome();
  const node = await installUpdatingNode(install, home);
  const started = await reins(["node", "start"], env);
  expect({ exitCode: started.exitCode, last: lastLine(started.output) }, readFileSync(install.paths.log, "utf8")).toEqual({ exitCode: 0, last: `Node laptop connected to http://reins.test (pid ${node.runs()[0]}).` });

  node.update();
  await until(() => install.status()?.state === "updating", "the node exited to restart on its new build");

  const launcher = install.status()!.pid;
  const status = await reins(["node", "status"], env);
  expect({ exitCode: status.exitCode, last: lastLine(status.stdout), running: install.status()?.running })
    .toEqual({ exitCode: 4, last: `Restarting on a new build since ${install.status()!.since}.`, running: true });

  const again = reins(["node", "start"], env);
  node.release();
  const run = await again;

  expect(run.stdout).toContain(`The node is already running (pid ${launcher})`);
  expect({ exitCode: run.exitCode, last: lastLine(run.output), runs: node.runs().length }).toEqual({ exitCode: 0, last: `Node laptop connected to http://reins.test (pid ${node.runs()[1]}).`, runs: 2 });
}, 30_000);

test("stop while its launcher restarts the node on a new build stops the launcher: the node does not come back", async () => {
  const { home, install, env } = await pairedHome();
  const node = await installUpdatingNode(install, home);
  expect((await reins(["node", "start"], env)).exitCode).toBe(0);
  node.update();
  await until(() => install.status()?.state === "updating", "the node exited to restart on its new build");
  const launcher = install.status()!.pid;

  const stop = await reins(["node", "stop"], env);

  expect({ exitCode: stop.exitCode, last: lastLine(stop.stdout) }).toEqual({ exitCode: 0, last: `Node stopped (pid ${launcher}).` });
  node.release();
  await Bun.sleep(300);
  expect({ running: install.status()?.running, connected: install.status()?.state === "connected", stopAgain: lastLine((await reins(["node", "stop"], env)).stdout) })
    .toEqual({ running: false, connected: false, stopAgain: "Node not running." });
}, 30_000);

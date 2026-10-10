import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateNodeKeyPair } from "@reins/node-protocol";
import { lastLine, reins } from "../testing/reins.js";
import { processStartTime, statusPath } from "./background.js";
import { saveNodeIdentity } from "./config.js";

const temps: string[] = [];
const children: Bun.Subprocess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A paired node's home, with nothing installed. */
async function pairedHome() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "reins-node-control-")));
  temps.push(home);
  await saveNodeIdentity(home, { serverUrl: "http://reins.test", nodeId: "laptop", privateKey: generateNodeKeyPair().privateKey });
  return home;
}

test("start refuses a node that was not installed: there is no launcher; run it in the foreground", async () => {
  const home = await pairedHome();

  const run = await reins(["node", "start"], { REINS_NODE_DATA_DIR: home });

  expect({ exitCode: run.exitCode, last: lastLine(run.stderr) }).toEqual({
    exitCode: 1, last: `Not started: this node was not installed (no ${join(home, "bin", "reins")}). Run it in the foreground instead: reins node run`,
  });
});

test("a status file whose pid now names another process is not trusted: status says not running and stop signals nothing", async () => {
  const home = await pairedHome();
  // A live process under the recorded pid, but not the one that wrote it: it started at another time.
  const other = Bun.spawn(["sleep", "30"]);
  children.push(other);
  await Bun.sleep(50);
  expect(processStartTime(other.pid)).not.toBeNull();
  mkdirSync(join(home, "run"));
  writeFileSync(statusPath(home), JSON.stringify({ pid: other.pid, started: "1", state: "connected", serverUrl: "http://reins.test", since: "2026-10-10T06:00:00.000Z" }));
  const env = { REINS_NODE_DATA_DIR: home };

  const status = await reins(["node", "status"], env);
  const stop = await reins(["node", "stop"], env);

  expect({ exitCode: status.exitCode, last: lastLine(status.stdout) }).toEqual({ exitCode: 3, last: "Not running (last connected at 2026-10-10T06:00:00.000Z). Start it: reins node start" });
  expect({ exitCode: stop.exitCode, last: lastLine(stop.stdout) }).toEqual({ exitCode: 0, last: "Node not running." });
  await Bun.sleep(100);
  expect({ exitCode: other.exitCode, signalCode: other.signalCode }).toEqual({ exitCode: null, signalCode: null });
});

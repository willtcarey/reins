import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateNodeKeyPair } from "@reins/node-protocol";
import { lastLine, reins } from "../testing/reins.js";
import { readNodeConfig, saveNodeIdentity } from "./config.js";

const temps: string[] = [];
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function tempDir(prefix: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}

/** A paired node's home. */
async function pairedHome() {
  const home = tempDir("reins-node-source-home-");
  await saveNodeIdentity(home, { serverUrl: "http://reins.test", nodeId: "laptop", privateKey: generateNodeKeyPair().privateKey });
  return home;
}

test("source add declares a checkout by its real path, once; list shows the node's sources", async () => {
  const home = await pairedHome();
  const checkouts = tempDir("reins-node-source-");
  mkdirSync(join(checkouts, "app"));
  symlinkSync(join(checkouts, "app"), join(checkouts, "app-link"));
  const env = { REINS_NODE_DATA_DIR: home };

  const added = await reins(["node", "source", "add", join(checkouts, "app-link")], env);
  expect({ exitCode: added.exitCode, last: lastLine(added.stdout) }).toEqual({ exitCode: 0, last: `Source added: ${join(checkouts, "app")}` });
  const again = await reins(["node", "source", "add", `${join(checkouts, "app")}/`], env);
  expect({ exitCode: again.exitCode, last: lastLine(again.stdout) }).toEqual({ exitCode: 0, last: `Already a source: ${join(checkouts, "app")}` });

  expect((await readNodeConfig(home))!.sources).toEqual([join(checkouts, "app")]);
  expect((await reins(["node", "source", "list"], env)).stdout).toBe(`${join(checkouts, "app")}\n`);
});

test("source add refuses a path that is not an existing directory, changing nothing", async () => {
  const home = await pairedHome();
  const checkouts = tempDir("reins-node-source-");
  writeFileSync(join(checkouts, "file.txt"), "");
  const env = { REINS_NODE_DATA_DIR: home };

  for (const path of [join(checkouts, "missing"), join(checkouts, "file.txt")]) {
    const run = await reins(["node", "source", "add", path], env);
    expect({ exitCode: run.exitCode, last: lastLine(run.stderr) }).toEqual({ exitCode: 1, last: `Not added: ${path} is not a directory` });
  }
  expect((await readNodeConfig(home))!.sources).toEqual([]);
});

test("source remove forgets a declared checkout, also one whose directory is gone; an undeclared path is an error", async () => {
  const home = await pairedHome();
  const checkouts = tempDir("reins-node-source-");
  for (const name of ["app", "old"]) mkdirSync(join(checkouts, name));
  const env = { REINS_NODE_DATA_DIR: home };
  for (const name of ["app", "old"]) await reins(["node", "source", "add", join(checkouts, name)], env);
  rmSync(join(checkouts, "old"), { recursive: true });

  const removed = await reins(["node", "source", "remove", join(checkouts, "old")], env);
  expect({ exitCode: removed.exitCode, last: lastLine(removed.stdout) }).toEqual({ exitCode: 0, last: `Source removed: ${join(checkouts, "old")}` });
  const unknown = await reins(["node", "source", "remove", join(checkouts, "other")], env);
  expect({ exitCode: unknown.exitCode, last: lastLine(unknown.stderr) }).toEqual({ exitCode: 1, last: `Not removed: ${join(checkouts, "other")} is not a source of this node` });

  expect((await readNodeConfig(home))!.sources).toEqual([join(checkouts, "app")]);
});

test("an unpaired machine has no sources to change", async () => {
  const home = tempDir("reins-node-source-home-");
  const run = await reins(["node", "source", "add", home], { REINS_NODE_DATA_DIR: home });
  expect({ exitCode: run.exitCode, last: lastLine(run.stderr) }).toEqual({
    exitCode: 1, last: `Not changed: this machine's node is not paired (no ${join(home, "node.json")}). Pair it first: reins node pair <server URL> <code>`,
  });
});

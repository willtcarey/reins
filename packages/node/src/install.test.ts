import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeNodePublicKey, generateNodeKeyPair } from "@reins/node-protocol";
import { NodeInstall, RESTART_EXIT_CODE, runningBundle } from "./install.js";

const temps: string[] = [];
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function tempDir(prefix: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}

/** An install in a home that does not exist yet. */
function freshInstall(prefix = "reins-install-") {
  const home = join(tempDir(prefix), "home");
  return { home, install: NodeInstall.of({ REINS_NODE_DATA_DIR: home }) };
}

/** Every file under `dir`, by relative path, with its contents (a symlink: its target). */
function files(dir: string): Record<string, string> {
  if (!existsSync(dir)) return {};
  const entries = readdirSync(dir, { recursive: true, encoding: "utf8" }).toSorted();
  return Object.fromEntries(entries.flatMap(entry => {
    const path = join(dir, entry);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return [[entry, `-> ${readlinkSync(path)}`]];
    return stat.isFile() ? [[entry, readFileSync(path, "utf8")]] : [];
  }));
}

/** A node bundle elsewhere (a download) whose source is `source`. */
async function bundleOf(source: string) {
  const path = join(tempDir("reins-install-bundle-"), "reins.js");
  writeFileSync(path, source);
  return runningBundle(path, {});
}

/** What the installed launcher prints when it runs the current build with `args`. */
async function launch(install: NodeInstall, ...args: string[]) {
  const proc = Bun.spawn([install.paths.launcher, ...args], { env: { PATH: process.env.PATH }, stdout: "pipe", stderr: "inherit" });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { stdout, exitCode };
}

const privateKey = () => generateNodeKeyPair().privateKey;

test("an unpaired home has no pairing; a saved one reads back, with its private key (0600) as its key for its server", async () => {
  const { install } = freshInstall();
  expect(await install.pairing()).toBeNull();
  const key = privateKey();

  const saved = await install.savePairing({ serverUrl: "https://reins.example/base", nodeId: "n1", privateKey: key });

  expect(await install.pairing()).toEqual(saved);
  expect(saved).toMatchObject({ serverUrl: "https://reins.example/base", nodeId: "n1" });
  const nodeKey = await install.key(saved);
  expect({ origin: nodeKey.origin, key: encodeNodePublicKey(nodeKey.privateKey) }).toEqual({ origin: "https://reins.example", key: encodeNodePublicKey(key) });
  expect(statSync(saved.keyPath).mode & 0o777).toBe(0o600);
  expect(statSync(install.paths.pairing).mode & 0o777).toBe(0o600);
});

/** A `node.json` this release did not write: a newer release's, or a broken one. */
function foreignPairing(install: NodeInstall, json: unknown) {
  mkdirSync(join(install.paths.pairing, ".."), { recursive: true });
  writeFileSync(install.paths.pairing, JSON.stringify(json));
}

test("a pairing a newer release of the same version wrote reads with the fields it added; one of another version is refused", async () => {
  const { install } = freshInstall();
  const pairing = { version: 1 as const, serverUrl: "https://reins.example", nodeId: "n1", keyPath: "/keys/n1.pem" };

  foreignPairing(install, { ...pairing, later: { added: true } });
  expect(await install.pairing()).toEqual({ ...pairing, later: { added: true } });

  foreignPairing(install, { ...pairing, version: 2 });
  await expect(install.pairing()).rejects.toThrow("Unsupported node config version 2");
});

test("a pairing that cannot be saved leaves the previous one as it was, without the new key", async () => {
  const { home, install } = freshInstall();
  await install.savePairing({ serverUrl: "https://reins.example", nodeId: "first", privateKey: privateKey() });
  const before = files(home);
  chmodSync(home, 0o500);

  await expect(install.savePairing({ serverUrl: "https://reins.example", nodeId: "second", privateKey: privateKey() })).rejects.toThrow();

  chmodSync(home, 0o700);
  expect(files(home)).toEqual(before);
});

test("a node ID that is not safe in a path is refused, writing nothing", async () => {
  const { home, install } = freshInstall();

  await expect(install.savePairing({ serverUrl: "https://reins.example", nodeId: "../escape", privateKey: privateKey() })).rejects.toThrow("Node ID");

  expect(existsSync(home)).toBe(false);
});

test("installing a bundle run from elsewhere makes it the build the launcher runs; installing another switches to it", async () => {
  const { install } = freshInstall();
  const first = await bundleOf("console.log(1);\n");
  const second = await bundleOf("console.log(2);\n");
  expect({ current: await install.currentBuild(), installed: install.installed, command: install.command() }).toEqual({ current: null, installed: false, command: "reins" });

  await install.installBuild(first);
  // The installed copy does not need the download.
  rmSync(first.path);
  expect({ current: await install.currentBuild(), installed: install.installed, command: install.command(), run: await launch(install) })
    .toEqual({ current: first.buildId, installed: true, command: install.paths.launcher, run: { stdout: "1\n", exitCode: 0 } });

  await install.installBuild(second);
  expect({ current: await install.currentBuild(), run: await launch(install) }).toEqual({ current: second.buildId, run: { stdout: "2\n", exitCode: 0 } });
});

test("the launcher runs the build on the Bun that installed it, whatever PATH holds, and says what to do once that Bun is gone", async () => {
  const { home, install } = freshInstall();
  // A Bun the test can remove: a copy of this one, installing the build in a process of its own.
  const bun = join(tempDir("reins-install-bun-"), "bun");
  copyFileSync(process.execPath, bun);
  chmodSync(bun, 0o755);
  const bundle = await bundleOf("console.log(process.execPath);\n");
  const installing = Bun.spawn([bun, "-e", `
    import { NodeInstall, runningBundle } from ${JSON.stringify(Bun.resolveSync("./install.js", import.meta.dir))};
    await NodeInstall.of(process.env).installBuild(await runningBundle(${JSON.stringify(bundle.path)}, {}));
  `], { env: { REINS_NODE_DATA_DIR: home }, stdout: "inherit", stderr: "inherit" });
  expect(await installing.exited).toBe(0);
  const launched = async () => {
    const proc = Bun.spawn([install.paths.launcher], { env: { PATH: "" }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, exitCode };
  };

  expect(await launched()).toEqual({ stdout: `${bun}\n`, stderr: "", exitCode: 0 });

  rmSync(bun);
  expect(await launched()).toEqual({
    stdout: "", stderr: `Reins: this node's Bun (${bun}) is gone. Install Bun (https://bun.sh), then run the node's install command again.\n`, exitCode: 1,
  });
});

/** A bundle where the install script downloads it: in the home, under its build ID. */
async function placedByInstallScript(home: string, source: string) {
  const dir = join(home, "builds", sha256(source));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "reins.js"), source);
  return runningBundle(join(dir, "reins.js"), {});
}

test("installing the bundle where the install script put it makes it current", async () => {
  const { home, install } = freshInstall();
  const bundle = await placedByInstallScript(home, "console.log(3);\n");

  await install.installBuild(bundle);

  expect({ current: await install.currentBuild(), run: await launch(install) }).toEqual({ current: bundle.buildId, run: { stdout: "3\n", exitCode: 0 } });
});

test("the launcher runs the current build with the node home, the restart code and its own arguments, again each time it exits with that code, then exits as it did", async () => {
  // A home whose path needs quoting in sh.
  const { home, install } = freshInstall("reins-launcher-it's ");
  const log = join(tempDir("reins-launcher-log-"), "runs.log");
  // Exits with the restart code on its first two runs, then with 4.
  const bundle = await bundleOf(`
    const { appendFileSync, readFileSync } = require("node:fs");
    appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), home: process.env.REINS_NODE_DATA_DIR, restart: process.env.REINS_NODE_RESTART_EXIT_CODE }) + "\\n");
    process.exit(readFileSync(${JSON.stringify(log)}, "utf8").trim().split("\\n").length < 3 ? ${RESTART_EXIT_CODE} : 4);
  `);
  await install.installBuild(bundle);
  // The same home writes the same launcher.
  await install.installBuild(bundle);

  expect((await launch(install, "node", "run", "it's")).exitCode).toBe(4);

  const run = { argv: ["node", "run", "it's"], home, restart: String(RESTART_EXIT_CODE) };
  expect(readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line))).toEqual([run, run, run]);
});

test("a bundle knows its build and whether a launcher runs it again", async () => {
  const path = join(tempDir("reins-running-"), "reins.js");
  writeFileSync(path, "console.log(1);\n");
  const buildId = createHash("sha256").update("console.log(1);\n").digest("hex");

  expect(await runningBundle(path, {})).toEqual({ path, buildId, restartable: false });
  expect(await runningBundle(path, { REINS_NODE_RESTART_EXIT_CODE: String(RESTART_EXIT_CODE) })).toEqual({ path, buildId, restartable: true });
});

// -- Updates ------------------------------------------------------------------------------------------

const SERVER = "http://reins.example.test:3100";
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** An installed node running build "old". */
async function installedNode() {
  const { home, install } = freshInstall("reins-update-");
  const old = await bundleOf("console.log(\"old\");\n");
  await install.installBuild(old);
  return { home, install, old };
}

/** A build the server offers: its bytes and the `update` reply naming it. */
function build(source: string) {
  const id = sha256(source);
  return { source, update: { buildId: id, sha256: id } };
}

/** A fetch answering each URL from `routes` (else 404), recording what was asked. */
function fetcher(routes: Record<string, () => Response>) {
  const urls: string[] = [];
  const fetch = async (url: string) => {
    urls.push(url);
    return routes[url]?.() ?? new Response("Not found", { status: 404 });
  };
  return { urls, fetch };
}

test("an update downloads the build from the server, and nothing else, checks it and makes it the launcher's", async () => {
  const { install } = await installedNode();
  const next = build("console.log(\"next\");\n");
  const server = fetcher({ [`${SERVER}/nodes/builds/${next.update.buildId}/reins.js`]: () => new Response(next.source) });

  await install.installUpdate(SERVER, next.update, { fetch: server.fetch });

  expect(server.urls).toEqual([`${SERVER}/nodes/builds/${next.update.buildId}/reins.js`]);
  expect({ current: await install.currentBuild(), run: await launch(install) }).toEqual({ current: next.update.buildId, run: { stdout: "next\n", exitCode: 0 } });

  // Installed already, it is not downloaded again.
  await install.installUpdate(SERVER, next.update, { fetch: server.fetch });
  expect(server.urls).toHaveLength(1);
});

test("a download that fails, or does not match its checksum, leaves the home as it was", async () => {
  const { home, install, old } = await installedNode();
  const next = build("console.log(\"next\");\n");
  const url = `${SERVER}/nodes/builds/${next.update.buildId}/reins.js`;
  const before = files(home);

  await expect(install.installUpdate(SERVER, next.update, { fetch: fetcher({ [url]: () => new Response("Building", { status: 503 }) }).fetch }))
    .rejects.toThrow(`could not download build ${next.update.buildId.slice(0, 12)} from ${SERVER}: HTTP 503`);
  await expect(install.installUpdate(SERVER, next.update, { fetch: fetcher({ [url]: () => new Response("console.log(\"tampered\");\n") }).fetch }))
    .rejects.toThrow(`build ${next.update.buildId.slice(0, 12)} from ${SERVER} does not match its checksum`);

  expect({ current: await install.currentBuild(), files: files(home) }).toEqual({ current: old.buildId, files: before });
});

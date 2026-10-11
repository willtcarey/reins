import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { logger } from "../../logger.js";
import type { NodeBundle } from "../../node-bundle/build.js";
import { bunMajorOf, serveNodeBundle } from "../../node-bundle/delivery.js";
import { buildRouter } from "../../routes/index.js";
import { makeRequest } from "../helpers/request.js";
import { createServerState, testNodeBundle } from "../helpers/server-state.js";
import { useTestDb } from "../helpers/test-db.js";

useTestDb();
const router = buildRouter();
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The major version of the Bun running the tests, which the install script finds on PATH (`install`). */
const BUN_MAJOR = bunMajorOf(Bun.version);

/** A server state serving `bundle`, for nodes on Bun `bunMajor`.x (this one's by default). */
function stateServing(bundle: Promise<NodeBundle>, { bunMajor = BUN_MAJOR }: { bunMajor?: number } = {}) {
  const state = createServerState({ nodeBundle: serveNodeBundle(bundle, { bunMajor }) });
  cleanups.push(() => void state.nodes.close());
  return state;
}

const get = async (state: ReturnType<typeof stateServing>, path: string, headers: Record<string, string> = {}) =>
  (await router.handle(makeRequest(path, { headers }), state))!;

/** The values the install script was filled in with. */
const scriptValues = (script: string) => Object.fromEntries([...script.matchAll(/^(server|build_id|sha256|bun_major)=(.*)$/gm)].map(([, name, value]) => [name, value]));

test("the manifest names the build, its sha256, its size and the major version of Bun it runs on; the bundle is served under its build ID only", async () => {
  const bundle = testNodeBundle();
  const state = stateServing(Promise.resolve(bundle), { bunMajor: 7 });

  const manifest = await get(state, "/nodes/manifest");
  expect(await manifest.json()).toEqual({ buildId: bundle.buildId, sha256: bundle.buildId, bunMajor: 7, size: bundle.bytes.byteLength });

  const download = await get(state, `/nodes/builds/${bundle.buildId}/reins.js`);
  expect({ status: download.status, bytes: new Uint8Array(await download.arrayBuffer()) }).toEqual({ status: 200, bytes: bundle.bytes });
  const other = await get(state, `/nodes/builds/${"0".repeat(64)}/reins.js`);
  expect(other.status).toBe(404);
});

test("the install script names the server the request reached, through a proxy's forwarded headers, the build to fetch and the Bun it needs", async () => {
  const bundle = testNodeBundle();
  const state = stateServing(Promise.resolve(bundle), { bunMajor: 7 });

  const direct = await get(state, "/nodes/install", { Host: "reins.local:3100" });
  expect(direct.status).toBe(200);
  expect(scriptValues(await direct.text())).toEqual({ server: "'http://reins.local:3100'", build_id: `'${bundle.buildId}'`, sha256: `'${bundle.buildId}'`, bun_major: "'7'" });

  const proxied = await get(state, "/nodes/install", { Host: "localhost:3100", "X-Forwarded-Proto": "https", "X-Forwarded-Host": "reins.example.ts.net" });
  expect(scriptValues(await proxied.text()).server).toBe("'https://reins.example.ts.net'");
});

test("while the build runs requests wait for it; a failed build is logged once and answers 503", async () => {
  let finish!: (bundle: NodeBundle) => void;
  const building = stateServing(new Promise(resolve => { finish = resolve; }));
  const manifest = get(building, "/nodes/manifest");
  finish(testNodeBundle());
  expect((await manifest).status).toBe(200);

  const logged = spyOn(logger, "error").mockImplementation(() => {});
  cleanups.push(() => logged.mockRestore());
  const failed = stateServing(Promise.reject(new Error("build failed")));
  for (const path of ["/nodes/manifest", `/nodes/builds/${testNodeBundle().buildId}/reins.js`]) {
    expect({ path, status: (await get(failed, path)).status }).toEqual({ path, status: 503 });
  }
  expect(logged).toHaveBeenCalledTimes(1);
});

test("without a bundle to install (its build failed, or is not done in time), the install script is one that says so and fails, since sh cannot see an HTTP error", async () => {
  const logged = spyOn(logger, "error").mockImplementation(() => {});
  cleanups.push(() => logged.mockRestore());
  const failed = serve(stateServing(Promise.reject(new Error("build failed"))));
  const slowState = createServerState({ nodeBundle: serveNodeBundle(new Promise(() => {}), { bunMajor: BUN_MAJOR, installWaitMs: 10 }) });
  cleanups.push(() => void slowState.nodes.close());
  const slow = serve(slowState);

  expect(await install(failed, tempDir("reins-install-"), ["the-code"])).toEqual({
    exitCode: 1, stdout: "", stderr: "Reins node install failed: the server could not build the node; see its log\n",
  });
  expect(await install(slow, tempDir("reins-install-"), ["the-code"])).toEqual({
    exitCode: 1, stdout: "", stderr: "Reins node install failed: the server is still building the node; try again in a minute\n",
  });
});

/** Serves `/nodes/*` from `state` over HTTP, the bundle download replaced by `bundleBytes` if given. */
function serve(state: ReturnType<typeof stateServing>, bundleBytes?: Uint8Array<ArrayBuffer>) {
  const server = Bun.serve({
    port: 0,
    fetch: async request => (bundleBytes && new URL(request.url).pathname.startsWith("/nodes/builds/") ? new Response(bundleBytes) : (await router.handle(request, state))!),
  });
  cleanups.push(() => server.stop(true));
  return `http://127.0.0.1:${server.port}`;
}

/** `curl -fsSL <server>/nodes/install | sh -s -- …args` with `home` as the node home, and the Bun running
 * the tests first on `PATH` (by default). */
async function install(serverUrl: string, home: string, args: string[], { path = `${dirname(process.execPath)}:${process.env.PATH}` }: { path?: string } = {}) {
  const proc = Bun.spawn(["sh", "-c", `curl -fsSL ${serverUrl}/nodes/install | sh -s -- "$@"`, "sh", ...args], {
    env: { PATH: path, HOME: tempDir("reins-install-home-"), REINS_NODE_DATA_DIR: home }, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { exitCode, stdout, stderr };
}

/** A `PATH` holding only `sh` and `curl`: no Bun. */
function pathWithoutBun(): string {
  const bin = tempDir("reins-install-bin-");
  for (const tool of ["sh", "curl"]) symlinkSync(Bun.which(tool)!, join(bin, tool));
  return bin;
}

test("the install script needs Bun of the server's major version on PATH: without one, or with another, it says so and fails, installing nothing", async () => {
  const bundle = testNodeBundle("console.log(\"ran\");\n");
  const home = join(tempDir("reins-install-"), "home");

  const missing = await install(serve(stateServing(Promise.resolve(bundle))), home, ["the-code"], { path: pathWithoutBun() });
  const other = await install(serve(stateServing(Promise.resolve(bundle), { bunMajor: BUN_MAJOR + 1 })), home, ["the-code"]);

  expect([missing, other]).toEqual([
    { exitCode: 1, stdout: "", stderr: `Reins needs Bun ${BUN_MAJOR}.x on PATH: install it from https://bun.sh, then run this command again\n` },
    { exitCode: 1, stdout: "", stderr: `Reins needs Bun ${BUN_MAJOR + 1}.x on PATH, and ${process.execPath} is Bun ${Bun.version}: install it from https://bun.sh, then run this command again\n` },
  ]);
  expect(existsSync(home)).toBe(false);
});

test("the install script puts the bundle in the node home under its build ID and hands over to it, on the Bun on PATH: node setup <server> and its own arguments", async () => {
  // A bundle that prints what it was run with.
  const bundle = testNodeBundle("console.log(JSON.stringify({ argv: process.argv.slice(2), home: process.env.REINS_NODE_DATA_DIR, bun: process.execPath }));\n");
  const state = stateServing(Promise.resolve(bundle));
  const serverUrl = serve(state);
  const home = tempDir("reins-install-");

  const run = await install(serverUrl, home, ["the-code"]);

  expect({ exitCode: run.exitCode, stderr: run.stderr }).toEqual({ exitCode: 0, stderr: "" });
  expect(JSON.parse(run.stdout.trimEnd().split("\n").at(-1)!)).toEqual({ argv: ["node", "setup", serverUrl, "the-code"], home, bun: process.execPath });
  expect(readFileSync(join(home, "builds", bundle.buildId, "reins.js"))).toEqual(Buffer.from(bundle.bytes));
  expect(readdirSync(join(home, "builds", bundle.buildId))).toEqual(["reins.js"]);
});

test("the install script refuses a bundle that does not match its checksum, running nothing", async () => {
  const bundle = testNodeBundle("console.log(\"ran\");\n");
  const serverUrl = serve(stateServing(Promise.resolve(bundle)), new TextEncoder().encode("console.log(\"tampered\");\n"));
  const home = tempDir("reins-install-");

  const run = await install(serverUrl, home, ["the-code"]);

  expect({ exitCode: run.exitCode, stdout: run.stdout.includes("ran") || run.stdout.includes("tampered"), stderr: run.stderr })
    .toEqual({ exitCode: 1, stdout: false, stderr: `Reins node install failed: the node bundle from ${serverUrl} does not match its checksum\n` });
  expect(readdirSync(join(home, "builds", bundle.buildId))).toEqual([]);
});

test("the install script without a pairing code says how to run it", async () => {
  const run = await install(serve(stateServing(Promise.resolve(testNodeBundle()))), tempDir("reins-install-"), []);
  expect({ exitCode: run.exitCode, stderr: run.stderr }).toEqual({ exitCode: 1, stderr: expect.stringMatching(/^Reins node install failed: no pairing code\. Usage: curl -fsSL http:\/\/127\.0\.0\.1:\d+\/nodes\/install \| sh -s -- <pairing code>\n$/) });
});


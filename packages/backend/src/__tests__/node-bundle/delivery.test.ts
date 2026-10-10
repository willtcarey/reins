import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleFetch } from "../../handler.js";
import { logger } from "../../logger.js";
import type { NodeBundle } from "../../node-bundle/build.js";
import { serveNodeBundle } from "../../node-bundle/delivery.js";
import { makeRequest } from "../helpers/request.js";
import { createServerState, testNodeBundle } from "../helpers/server-state.js";
import { useTestDb } from "../helpers/test-db.js";

useTestDb();
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A server state whose web app answers every other path, serving `bundle`. */
function stateServing(bundle: Promise<NodeBundle>) {
  const frontendDir = tempDir("reins-delivery-spa-");
  writeFileSync(join(frontendDir, "index.html"), "<html>spa</html>");
  const state = createServerState({ frontendDir, nodeBundle: serveNodeBundle(bundle, { bunVersion: "1.3.9" }) });
  cleanups.push(() => void state.nodes.close());
  return state;
}

const get = async (state: ReturnType<typeof stateServing>, path: string, headers: Record<string, string> = {}) =>
  (await handleFetch(state, makeRequest(path, { headers }), null))!;

/** The values the install script was filled in with. */
const scriptValues = (script: string) => Object.fromEntries([...script.matchAll(/^(server|build_id|sha256|bun_version)=(.*)$/gm)].map(([, name, value]) => [name, value]));

test("the manifest names the build, its sha256, its size and the Bun it runs on; the bundle is served under its build ID only", async () => {
  const bundle = testNodeBundle();
  const state = stateServing(Promise.resolve(bundle));

  const manifest = await get(state, "/nodes/manifest");
  expect(await manifest.json()).toEqual({ buildId: bundle.buildId, sha256: bundle.buildId, bunVersion: "1.3.9", size: bundle.bytes.byteLength });

  const download = await get(state, `/nodes/builds/${bundle.buildId}/reins.js`);
  expect({ status: download.status, bytes: new Uint8Array(await download.arrayBuffer()) }).toEqual({ status: 200, bytes: bundle.bytes });
  const other = await get(state, `/nodes/builds/${"0".repeat(64)}/reins.js`);
  expect(other.status).toBe(404);
});

test("the install script names the server the request reached, through a proxy's forwarded headers, and the build to fetch", async () => {
  const bundle = testNodeBundle();
  const state = stateServing(Promise.resolve(bundle));

  const direct = await get(state, "/nodes/install", { Host: "reins.local:3100" });
  expect(direct.status).toBe(200);
  expect(scriptValues(await direct.text())).toEqual({ server: "'http://reins.local:3100'", build_id: `'${bundle.buildId}'`, sha256: `'${bundle.buildId}'`, bun_version: "'1.3.9'" });

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
  const slowState = createServerState({ nodeBundle: serveNodeBundle(new Promise(() => {}), { bunVersion: "1.3.9", installWaitMs: 10 }) });
  cleanups.push(() => void slowState.nodes.close());
  const slow = serve(slowState);

  expect(await install(failed, homeWithBun(), ["the-code"])).toEqual({
    exitCode: 1, stdout: "", stderr: "Reins node install failed: the server could not build the node; see its log\n",
  });
  expect(await install(slow, homeWithBun(), ["the-code"])).toEqual({
    exitCode: 1, stdout: "", stderr: "Reins node install failed: the server is still building the node; try again in a minute\n",
  });
});

test("other paths under /nodes/ are 404, never the web app", async () => {
  const state = stateServing(Promise.resolve(testNodeBundle()));
  for (const path of ["/nodes/", "/nodes/installer", "/nodes/builds/abc", "/nodes/builds/abc/other.js"]) {
    const response = await get(state, path);
    expect({ path, status: response.status, body: await response.text() }).toEqual({ path, status: 404, body: expect.not.stringContaining("spa") });
  }
});

/** Serves `/nodes/*` from `state` over HTTP, the bundle download replaced by `bundleBytes` if given. */
function serve(state: ReturnType<typeof stateServing>, bundleBytes?: Uint8Array<ArrayBuffer>) {
  const server = Bun.serve({
    port: 0,
    fetch: async request => (bundleBytes && new URL(request.url).pathname.startsWith("/nodes/builds/") ? new Response(bundleBytes) : (await handleFetch(state, request, null))!),
  });
  cleanups.push(() => server.stop(true));
  return `http://127.0.0.1:${server.port}`;
}

/** `curl -fsSL <server>/nodes/install | sh -s -- …args` with `home` as the node home. */
async function install(serverUrl: string, home: string, args: string[]) {
  const proc = Bun.spawn(["sh", "-c", `curl -fsSL ${serverUrl}/nodes/install | sh -s -- "$@"`, "sh", ...args], {
    env: { PATH: process.env.PATH, HOME: tempDir("reins-install-home-"), REINS_NODE_DATA_DIR: home }, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { exitCode, stdout, stderr };
}

/** A node home whose Bun is this one (`bun --version` is the pinned version), so nothing downloads Bun. */
function homeWithBun(): string {
  const home = tempDir("reins-install-");
  symlinkSync(process.execPath, join(home, "bun"));
  return home;
}

test("the install script puts the bundle in the node home under its build ID and hands over to it: node setup <server> and its own arguments", async () => {
  // A bundle that prints what it was run with.
  const bundle = testNodeBundle("console.log(JSON.stringify({ argv: process.argv.slice(2), home: process.env.REINS_NODE_DATA_DIR }));\n");
  const state = stateServing(Promise.resolve(bundle));
  const serverUrl = serve(state);
  const home = homeWithBun();

  const run = await install(serverUrl, home, ["the-code", "--source", "/src/app"]);

  expect({ exitCode: run.exitCode, stderr: run.stderr }).toEqual({ exitCode: 0, stderr: "" });
  expect(JSON.parse(run.stdout.trimEnd().split("\n").at(-1)!)).toEqual({ argv: ["node", "setup", serverUrl, "the-code", "--source", "/src/app"], home });
  expect(readFileSync(join(home, "builds", bundle.buildId, "reins.js"))).toEqual(Buffer.from(bundle.bytes));
  expect(readdirSync(join(home, "builds", bundle.buildId))).toEqual(["reins.js"]);
});

test("the install script refuses a bundle that does not match its checksum, running nothing", async () => {
  const bundle = testNodeBundle("console.log(\"ran\");\n");
  const serverUrl = serve(stateServing(Promise.resolve(bundle)), new TextEncoder().encode("console.log(\"tampered\");\n"));
  const home = homeWithBun();

  const run = await install(serverUrl, home, ["the-code"]);

  expect({ exitCode: run.exitCode, stdout: run.stdout.includes("ran") || run.stdout.includes("tampered"), stderr: run.stderr })
    .toEqual({ exitCode: 1, stdout: false, stderr: `Reins node install failed: the node bundle from ${serverUrl} does not match its checksum\n` });
  expect(readdirSync(join(home, "builds", bundle.buildId))).toEqual([]);
});

test("the install script without a pairing code says how to run it", async () => {
  const run = await install(serve(stateServing(Promise.resolve(testNodeBundle()))), homeWithBun(), []);
  expect({ exitCode: run.exitCode, stderr: run.stderr }).toEqual({ exitCode: 1, stderr: expect.stringMatching(/^Reins node install failed: no pairing code\. Usage: curl -fsSL http:\/\/127\.0\.0\.1:\d+\/nodes\/install \| sh -s -- <pairing code> \[--source <path>\]\.\.\.\n$/) });
});


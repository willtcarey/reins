import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRpcPeer, createWebSocketLink, generateNodeKeyPair, helloParams, helloResult, NODE_REFUSED, RpcFailure, type Hello, type HelloResult, type WebSocketLink } from "@reins/node-protocol";
import { lastLine, reins } from "../testing/reins.js";
import { NodeInstall, RESTART_EXIT_CODE, runningBundle } from "@reins/node/install";

const servers: { stop(force?: boolean): unknown }[] = [];
const temps: string[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "reins-node-run-"));
  temps.push(dir);
  return dir;
}

/** A node home paired with `serverUrl`. */
async function pairedHome(serverUrl: string) {
  const home = tempDir();
  const install = NodeInstall.of({ REINS_NODE_DATA_DIR: home });
  await install.savePairing({ serverUrl, nodeId: "laptop", privateKey: generateNodeKeyPair().privateKey });
  return { home, install };
}

interface LinkData { path: string; wire?: WebSocketLink }
const linkData: LinkData = { path: "" };
/** A server whose node link answers each hello with `answer` (given the hellos so far), recording the
 * paths it was dialed at and every hello; it serves `files` by path. */
function nodeLinkServer(answer: (hellos: readonly Hello[]) => HelloResult, files: Record<string, string> = {}) {
  const paths: string[] = [];
  const hellos: Hello[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request, bunServer) {
      const data: LinkData = { path: new URL(request.url).pathname };
      const file = files[data.path];
      if (file !== undefined) return new Response(file);
      return bunServer.upgrade(request, { data }) ? undefined : new Response("Upgrade required", { status: 426 });
    },
    websocket: {
      data: linkData,
      open(ws) {
        paths.push(ws.data.path);
        const wire = createWebSocketLink({ send: text => ws.send(text), bufferedAmount: () => ws.getBufferedAmount(), close: (code, reason) => ws.close(code, reason) }, { maxFrameBytes: 1024 * 1024 });
        ws.data.wire = wire;
        const peer = createRpcPeer(wire, {
          "node.hello": { params: helloParams, result: helloResult, handle: async (hello: Hello) => { hellos.push(hello); return answer(hellos); } },
        });
        wire.onmessage = peer.receive;
        wire.onclose = peer.close;
      },
      message(ws, message) { ws.data.wire?.receive(message); },
      close(ws) { ws.data.wire?.ended(); },
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, paths, hellos };
}

/** Refuses a hello as the server refuses a revoked node. */
const refuse = (hellos: readonly Hello[]): never => { throw new RpcFailure(NODE_REFUSED, `Node revoked: ${hellos.at(-1)!.nodeId}`); };

test("an unpaired machine has no node to run: exits 1 saying how to pair it", async () => {
  const home = tempDir();
  const run = await reins(["node", "run"], { REINS_NODE_DATA_DIR: home });
  expect({ exitCode: run.exitCode, last: lastLine(run.stderr) }).toEqual({
    exitCode: 1, last: `Not running: this machine's node is not paired (no ${join(home, "node.json")}). Pair it first: reins node pair <server URL> <code>`,
  });
});

test("runs the paired node over the server's node link; a server that refuses it stops it with exit 4 and a hint to pair again, and its status records the refusal", async () => {
  const server = nodeLinkServer(refuse);
  const { home, install } = await pairedHome(server.url);

  const run = await reins(["node", "run"], { REINS_NODE_DATA_DIR: home });

  expect(server.paths).toEqual(["/nodes/link"]);
  expect(run.stdout).toContain(`[node] dialing server at ws://127.0.0.1:${new URL(server.url).port}/nodes/link as node laptop`);
  expect(run.stdout).toContain("[node] refused by the server: Node revoked: laptop; not reconnecting");
  expect({ exitCode: run.exitCode, last: lastLine(run.output) }).toEqual({
    exitCode: 4, last: `Node stopped: ${server.url} refused it (Node revoked: laptop). Pair this machine again: reins node pair --force ${server.url} <code>`,
  });
  expect(install.status()).toMatchObject({ state: "refused", message: "Node revoked: laptop", serverUrl: server.url });
});

test("a node does not run while another node of its home runs: exits 1 naming it, and dials nothing", async () => {
  const server = nodeLinkServer(refuse);
  const { home, install } = await pairedHome(server.url);
  // Another node of the home: it has recorded itself in the status file and runs on.
  const other = Bun.spawn([process.execPath, "-e", `
    import { NodeInstall } from ${JSON.stringify(Bun.resolveSync("@reins/node/install", import.meta.dir))};
    NodeInstall.of(process.env).recorder({ serverUrl: "http://reins.test" }).recorder.set("connected");
    console.log("recorded");
    setInterval(() => {}, 1000);
  `], { env: { ...process.env, REINS_NODE_DATA_DIR: home }, stdout: "pipe" });
  try {
    for await (const _ of other.stdout) break;

    const run = await reins(["node", "run"], { REINS_NODE_DATA_DIR: home });

    expect({ exitCode: run.exitCode, last: lastLine(run.stderr) }).toEqual({
      exitCode: 1, last: `Not running: this machine's node is already running (pid ${other.pid}). Stop it first: reins node stop`,
    });
    expect(server.paths).toEqual([]);
    expect(install.status()).toMatchObject({ state: "connected", pid: other.pid, running: true });
  } finally { other.kill("SIGKILL"); }
});

/** A node home paired with `serverUrl`, running a build of its own on this Bun: the bundle it runs from. */
async function installedNode(serverUrl: string) {
  const { home, install } = await pairedHome(serverUrl);
  symlinkSync(process.execPath, join(home, "bun"));
  const bundle = join(tempDir(), "reins.js");
  writeFileSync(bundle, "console.log(\"old\");\n");
  const old = await runningBundle(bundle, {});
  await install.installBuild(old);
  return { home, install, old: old.buildId, bundle };
}

/** The server's build: its source and ID, served at `/nodes/builds/<id>/reins.js`. */
const NEXT = "console.log(\"next\");\n";
const NEXT_ID = createHash("sha256").update(NEXT).digest("hex");
const updateTo = (): HelloResult => ({ kind: "update", buildId: NEXT_ID, sha256: NEXT_ID, bunVersion: Bun.version });

test("a node bundle the server tells to update installs the server's build, makes it current and exits for its launcher to start it, recording that it is updating", async () => {
  const server = nodeLinkServer(updateTo, { [`/nodes/builds/${NEXT_ID}/reins.js`]: NEXT });
  const { home, install, old, bundle } = await installedNode(server.url);

  const run = await reins(["node", "run"], { REINS_NODE_DATA_DIR: home, REINS_NODE_RESTART_EXIT_CODE: String(RESTART_EXIT_CODE) }, { bundle });

  expect(server.hellos.map(hello => hello.buildId)).toEqual([old]);
  expect(run.stdout).toContain(`[node] the server runs build ${NEXT_ID.slice(0, 12)}; updating to it`);
  expect({ exitCode: run.exitCode, last: lastLine(run.output) }).toEqual({ exitCode: RESTART_EXIT_CODE, last: `[node] build ${NEXT_ID.slice(0, 12)} installed; restarting on it` });
  expect(await install.currentBuild()).toBe(NEXT_ID);
  expect(install.status()).toMatchObject({ state: "updating", buildId: old });
});

test("a node bundle run without its launcher installs the update the same way, says to start it again and exits with the restart code", async () => {
  const server = nodeLinkServer(updateTo, { [`/nodes/builds/${NEXT_ID}/reins.js`]: NEXT });
  const { home, install, bundle } = await installedNode(server.url);

  const run = await reins(["node", "run"], { REINS_NODE_DATA_DIR: home }, { bundle });

  expect({ exitCode: run.exitCode, last: lastLine(run.output) }).toEqual({
    exitCode: RESTART_EXIT_CODE, last: `Node updated to build ${NEXT_ID.slice(0, 12)}, and nothing restarts it here: start it again with ${install.paths.launcher} node start`,
  });
  expect({ current: await install.currentBuild(), state: install.status()?.state }).toEqual({ current: NEXT_ID, state: "stopped" });
});

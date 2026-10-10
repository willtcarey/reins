import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRpcPeer, createWebSocketLink, generateNodeKeyPair, helloParams, helloResult, NODE_REFUSED, protocolVersion, RpcFailure, type Hello, type HelloResult, type WebSocketLink } from "@reins/node-protocol";
import { lastLine, reins } from "../testing/reins.js";
import { readNodeStatus } from "./background.js";
import { saveNodeIdentity } from "./config.js";
import { activateBuild, launcherPath, RESTART_EXIT_CODE } from "./install.js";

const servers: { stop(force?: boolean): unknown }[] = [];
const temps: string[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const until = async (condition: () => boolean) => { for (let i = 0; i < 400 && !condition(); i++) await Bun.sleep(5); expect(condition()).toBe(true); };

function tempHome() {
  const dir = mkdtempSync(join(tmpdir(), "reins-node-run-"));
  temps.push(dir);
  return dir;
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
  const home = tempHome();
  const run = await reins(["node", "run"], { REINS_NODE_DATA_DIR: home });
  expect({ exitCode: run.exitCode, last: lastLine(run.stderr) }).toEqual({
    exitCode: 1, last: `Not running: this machine's node is not paired (no ${join(home, "node.json")}). Pair it first: reins node pair <server URL> <code>`,
  });
});

test("runs the paired node over the server's node link; a server that refuses it stops it with exit 4 and a hint to pair again", async () => {
  const server = nodeLinkServer(refuse);
  const home = tempHome();
  await saveNodeIdentity(home, { serverUrl: server.url, nodeId: "laptop", privateKey: generateNodeKeyPair().privateKey });

  const run = await reins(["node", "run"], { REINS_NODE_DATA_DIR: home });

  expect(server.paths).toEqual(["/node-link"]);
  expect(run.stdout).toContain(`[node] dialing server at ws://127.0.0.1:${new URL(server.url).port}/node-link as node laptop`);
  expect(run.stdout).toContain("[node] refused by the server: Node revoked: laptop; not reconnecting");
  expect({ exitCode: run.exitCode, last: lastLine(run.output) }).toEqual({
    exitCode: 4, last: `Node stopped: ${server.url} refused it (Node revoked: laptop). Pair this machine again: reins node pair --force ${server.url} <code>`,
  });
});

test("the node reports its declared sources at each hello, and reconnects to report them again when they change while it runs", async () => {
  const server = nodeLinkServer(hellos => hellos.length === 1 ? { kind: "ready" as const, version: protocolVersion, capabilities: [], epoch: crypto.randomUUID() } : refuse(hellos));
  const home = tempHome();
  const checkouts = realpathSync(tempHome());
  for (const name of ["app", "docs"]) mkdirSync(join(checkouts, name));
  const env = { REINS_NODE_DATA_DIR: home };
  await saveNodeIdentity(home, { serverUrl: server.url, nodeId: "laptop", privateKey: generateNodeKeyPair().privateKey });
  await reins(["node", "source", "add", join(checkouts, "app")], env);

  const running = reins(["node", "run"], env);
  await until(() => server.hellos.length === 1);
  expect((await reins(["node", "source", "add", join(checkouts, "docs")], env)).exitCode).toBe(0);
  // The second hello is refused, which stops the node.
  const run = await running;

  expect(server.hellos.map(hello => hello.sources)).toEqual([[join(checkouts, "app")], [join(checkouts, "app"), join(checkouts, "docs")]]);
  expect(run.stdout).toContain("[node] sources changed; reconnecting to report them");
  expect(run.exitCode).toBe(4);
});

/** A node home paired with `serverUrl`, running a build of its own on this Bun. */
async function installedNode(serverUrl: string) {
  const home = tempHome();
  symlinkSync(process.execPath, join(home, "bun"));
  await saveNodeIdentity(home, { serverUrl, nodeId: "laptop", privateKey: generateNodeKeyPair().privateKey });
  writeFileSync(join(home, "old.js"), "console.log(\"old\");\n");
  const old = await activateBuild(home, join(home, "old.js"));
  return { home, old, bundle: join(home, "builds", old, "reins.js") };
}

/** The server's build: its source and ID, served at `/nodes/builds/<id>/reins.js`. */
const NEXT = "console.log(\"next\");\n";
const NEXT_ID = createHash("sha256").update(NEXT).digest("hex");
const updateTo = (): HelloResult => ({ kind: "update", buildId: NEXT_ID, sha256: NEXT_ID, bunVersion: Bun.version });

test("a node bundle the server tells to update installs the server's build, makes it current and exits for its launcher to start it, recording that it is updating", async () => {
  const server = nodeLinkServer(updateTo, { [`/nodes/builds/${NEXT_ID}/reins.js`]: NEXT });
  const { home, old, bundle } = await installedNode(server.url);

  const run = await reins(["node", "run"], { REINS_NODE_DATA_DIR: home, REINS_NODE_RESTART_EXIT_CODE: String(RESTART_EXIT_CODE) }, { bundle });

  expect(server.hellos.map(hello => hello.buildId)).toEqual([old]);
  expect(run.stdout).toContain(`[node] the server runs build ${NEXT_ID.slice(0, 12)}; updating to it`);
  expect({ exitCode: run.exitCode, last: lastLine(run.output) }).toEqual({ exitCode: RESTART_EXIT_CODE, last: `[node] build ${NEXT_ID.slice(0, 12)} installed; restarting on it` });
  expect({ current: readlinkSync(join(home, "current")), bundle: readFileSync(join(home, "current", "reins.js"), "utf8") }).toEqual({ current: join("builds", NEXT_ID), bundle: NEXT });
  expect(readNodeStatus(home)).toMatchObject({ state: "updating", buildId: old });
});

test("a node bundle run without its launcher installs the update the same way, says to start it again and exits with the restart code", async () => {
  const server = nodeLinkServer(updateTo, { [`/nodes/builds/${NEXT_ID}/reins.js`]: NEXT });
  const { home, bundle } = await installedNode(server.url);

  const run = await reins(["node", "run"], { REINS_NODE_DATA_DIR: home }, { bundle });

  expect({ exitCode: run.exitCode, last: lastLine(run.output) }).toEqual({
    exitCode: RESTART_EXIT_CODE, last: `Node updated to build ${NEXT_ID.slice(0, 12)}, and nothing restarts it here: start it again with ${launcherPath(home)} node start`,
  });
  expect({ current: readlinkSync(join(home, "current")), state: readNodeStatus(home)?.state }).toEqual({ current: join("builds", NEXT_ID), state: "stopped" });
});

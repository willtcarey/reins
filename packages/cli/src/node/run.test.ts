import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRpcPeer, createWebSocketLink, generateNodeKeyPair, helloParams, NODE_REFUSED, protocolVersion, readyResult, RpcFailure, type Hello, type Ready, type WebSocketLink } from "@reins/node-protocol";
import { lastLine, reins } from "../testing/reins.js";
import { saveNodeIdentity } from "./config.js";

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
 * paths it was dialed at and every hello. */
function nodeLinkServer(answer: (hellos: readonly Hello[]) => Ready) {
  const paths: string[] = [];
  const hellos: Hello[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request, bunServer) {
      const data: LinkData = { path: new URL(request.url).pathname };
      return bunServer.upgrade(request, { data }) ? undefined : new Response("Upgrade required", { status: 426 });
    },
    websocket: {
      data: linkData,
      open(ws) {
        paths.push(ws.data.path);
        const wire = createWebSocketLink({ send: text => ws.send(text), bufferedAmount: () => ws.getBufferedAmount(), close: (code, reason) => ws.close(code, reason) }, { maxFrameBytes: 1024 * 1024 });
        ws.data.wire = wire;
        const peer = createRpcPeer(wire, {
          "node.hello": { params: helloParams, result: readyResult, handle: async (hello: Hello) => { hellos.push(hello); return answer(hellos); } },
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
  const server = nodeLinkServer(hellos => hellos.length === 1 ? { version: protocolVersion, capabilities: [], epoch: crypto.randomUUID() } : refuse(hellos));
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

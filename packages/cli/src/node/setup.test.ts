import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRpcPeer, createWebSocketLink, generateNodeKeyPair, helloParams, helloResult, NODE_REFUSED, protocolVersion, RpcFailure, type Hello, type WebSocketLink } from "@reins/node-protocol";
import { z } from "zod";
import { lastLine, reins } from "../testing/reins.js";
import { NodeInstall, runningBundle } from "@reins/node/install";

const CLI = join(import.meta.dir, "../cli.ts");
const COMMAND = join(import.meta.dir, "../command.ts");
const INSTALL = Bun.resolveSync("@reins/node/install", import.meta.dir);

const servers: { stop(force?: boolean): unknown }[] = [];
const installs: NodeInstall[] = [];
const temps: string[] = [];
afterEach(async () => {
  for (const install of installs.splice(0)) await install.stop({ timeoutMs: 5_000 });
  for (const server of servers.splice(0)) server.stop(true);
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}

/** A node home, and the environment of commands run in it. */
function nodeHome() {
  const home = tempDir("reins-node-setup-");
  const install = NodeInstall.of({ REINS_NODE_DATA_DIR: home });
  installs.push(install);
  return { home, install, env: { REINS_NODE_DATA_DIR: home, HOME: tempDir("reins-node-setup-user-"), PATH: process.env.PATH } };
}

/** Whether process `pid` still runs. */
function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** A stand-in for the node bundle: a file elsewhere that runs this CLI's source as the bundle's entry does,
 * telling it the bundle it runs from. `variant` makes another build. */
function bundle(variant = "") {
  const path = join(tempDir("reins-node-bundle-"), "reins.js");
  writeFileSync(path, [
    `// ${variant}`,
    `import { runCli } from ${JSON.stringify(CLI)};`,
    `import { processContext } from ${JSON.stringify(COMMAND)};`,
    `import { runningBundle } from ${JSON.stringify(INSTALL)};`,
    "process.exit(await runCli(process.argv.slice(2), { ...processContext(), bundle: await runningBundle(import.meta.path, process.env) }));",
  ].join("\n"));
  return path;
}

interface LinkData { wire?: WebSocketLink }
const linkData: LinkData = {};
/** The message of the `error` reply a `reinsServer` answering "bun" sends. */
const NEEDS_BUN = "This server needs Bun 99.x; this node runs 1.3.9. Upgrade Bun on laptop, then: reins node start";

/** A Reins server as setup meets it: `POST /api/nodes/pair` redeems each of `codes` once (for a node named
 * "laptop"), and `/nodes/link` answers every hello as `answer` does, until `answerWith` changes it (it does
 * not challenge the node): "ready" serves the nodes it paired until `remove`d, and refuses others; "bun"
 * answers that it needs another Bun (`NEEDS_BUN`). */
function reinsServer(codes: string[], answer: "ready" | "refuse" | "bun" = "ready") {
  const unused = new Set(codes);
  const pairings: string[] = [];
  const hellos: Hello[] = [];
  const paired = new Set<string>();
  const server = Bun.serve({
    port: 0,
    async fetch(request, bunServer) {
      const { pathname } = new URL(request.url);
      if (pathname === "/nodes/link") return bunServer.upgrade(request, { data: {} }) ? undefined : new Response("Upgrade required", { status: 426 });
      if (request.method !== "POST" || pathname !== "/api/nodes/pair") return Response.json({ error: "Not found" }, { status: 404 });
      const { code } = z.object({ code: z.string() }).parse(await request.json());
      pairings.push(code);
      if (!unused.delete(code)) return Response.json({ error: "Invalid or expired pairing code" }, { status: 403 });
      const nodeId = randomUUID();
      paired.add(nodeId);
      return Response.json({ nodeId, name: "laptop" }, { status: 201 });
    },
    websocket: {
      data: linkData,
      open(ws) {
        const wire = createWebSocketLink({ send: text => ws.send(text), bufferedAmount: () => ws.getBufferedAmount(), close: (code, reason) => ws.close(code, reason) }, { maxFrameBytes: 1024 * 1024 });
        ws.data.wire = wire;
        const peer = createRpcPeer(wire, {
          "node.hello": {
            params: helloParams, result: helloResult,
            handle: async (hello: Hello) => {
              hellos.push(hello);
              if (answer === "refuse") throw new RpcFailure(NODE_REFUSED, `Node revoked: ${hello.nodeId}`);
              if (answer === "bun") return { kind: "error" as const, code: "bun_version", message: NEEDS_BUN };
              if (!paired.has(hello.nodeId)) throw new RpcFailure(NODE_REFUSED, "Not authenticated");
              return { kind: "ready" as const, version: protocolVersion, capabilities: [], epoch: randomUUID() };
            },
          },
        });
        wire.onmessage = peer.receive;
        wire.onclose = peer.close;
      },
      message(ws, message) { ws.data.wire?.receive(message); },
      close(ws) { ws.data.wire?.ended(); },
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, pairings, hellos, remove: (nodeId: string) => paired.delete(nodeId), answerWith: (next: typeof answer) => { answer = next; } };
}

const nodeLog = (install: NodeInstall) => existsSync(install.paths.log) ? readFileSync(install.paths.log, "utf8") : "(no log)";

test("from source, setup refuses: it installs the bundle it runs from", async () => {
  const server = reinsServer(["the-code"]);
  const { install, env } = nodeHome();

  const run = await reins(["node", "setup", server.url, "the-code"], env);

  expect({ exitCode: run.exitCode, last: lastLine(run.stderr) }).toEqual({
    exitCode: 1, last: `Not set up: reins node setup installs the node bundle it runs from, and this is not one. Install with: curl -fsSL ${server.url}/nodes/install | sh -s -- <code>; from source, use reins node pair and reins node run`,
  });
  expect({ pairings: server.pairings, current: await install.currentBuild() }).toEqual({ pairings: [], current: null });
});

test("a home paired with another server is refused before anything changes or the code is sent", async () => {
  const server = reinsServer(["the-code"]);
  const { home, install, env } = nodeHome();

  await install.savePairing({ serverUrl: "http://other.example:3100", nodeId: "laptop", privateKey: generateNodeKeyPair().privateKey });
  const pairedElsewhere = await reins(["node", "setup", server.url, "the-code"], env, { bundle: bundle() });
  expect({ exitCode: pairedElsewhere.exitCode, last: lastLine(pairedElsewhere.stderr) }).toEqual({
    exitCode: 3,
    last: `Not set up: this machine's node is paired with http://other.example:3100 (${join(home, "node.json")}); the code was not used. To pair it with ${server.url} instead: reins node pair --force ${server.url} <code>, then run the install command again`,
  });

  expect({ pairings: server.pairings, current: await install.currentBuild(), output: pairedElsewhere.output })
    .toEqual({ pairings: [], current: null, output: expect.not.stringContaining("the-code") });
});

test("setup makes its build current, writes the launcher, pairs and starts the node in the background until it connects; run again with the used code, it neither pairs again nor starts another node", async () => {
  const server = reinsServer(["the-code"]);
  const { install, env } = nodeHome();
  const reinsJs = bundle();
  const { buildId } = await runningBundle(reinsJs, {});

  const first = await reins(["node", "setup", server.url, "the-code"], env, { bundle: reinsJs });

  const config = (await install.pairing())!;
  const status = install.status()!;
  expect({ exitCode: first.exitCode, last: lastLine(first.output) }, nodeLog(install)).toEqual({
    exitCode: 0, last: `Node "laptop" (${config.nodeId}) connected to ${server.url} (pid ${status.pid}).`,
  });
  expect({ current: await install.currentBuild(), installed: install.installed }).toEqual({ current: buildId, installed: true });
  expect(status).toMatchObject({ state: "connected", buildId, serverUrl: server.url });
  expect(server.hellos.map(hello => hello.nodeId)).toEqual([config.nodeId]);

  const again = await reins(["node", "setup", server.url, "the-code"], env, { bundle: reinsJs });

  expect({ exitCode: again.exitCode, last: lastLine(again.output) }).toEqual({ exitCode: 0, last: `Node ${config.nodeId} connected to ${server.url} (pid ${status.pid}).` });
  expect(again.stdout).toContain(`Already paired with ${server.url} as node ${config.nodeId}; the code was not used.`);
  expect(again.stdout).toContain(`The node is already running this build (pid ${status.pid})`);
  expect({ pairings: server.pairings.length, hellos: server.hellos.length }).toEqual({ pairings: 1, hellos: 1 });
  expect(first.output + again.output).not.toContain("the-code");
}, 60_000);

test("setup from a newer build stops the node running the older one and starts it on the new one", async () => {
  const server = reinsServer(["the-code"]);
  const { install, env } = nodeHome();
  expect((await reins(["node", "setup", server.url, "the-code"], env, { bundle: bundle("first") })).exitCode, nodeLog(install)).toBe(0);
  const old = install.status()!;
  const newer = bundle("second");
  const { buildId: newerId } = await runningBundle(newer, {});

  const run = await reins(["node", "setup", server.url, "the-code"], env, { bundle: newer });

  const status = install.status()!;
  expect({ exitCode: run.exitCode, last: lastLine(run.output) }, nodeLog(install)).toEqual({ exitCode: 0, last: expect.stringContaining(`connected to ${server.url} (pid ${status.pid}).`) });
  expect(run.stdout).toContain(`Stopping the node running build ${old.buildId!.slice(0, 12)} (pid ${old.pid})`);
  expect({ oldRunning: alive(old.pid), buildId: status.buildId, current: await install.currentBuild(), hellos: server.hellos.length })
    .toEqual({ oldRunning: false, buildId: newerId, current: newerId, hellos: 2 });
}, 60_000);

test("a node the server refuses ends setup's wait with exit 4 and the hint to pair again", async () => {
  const server = reinsServer(["the-code"], "refuse");
  const { install, env } = nodeHome();

  const run = await reins(["node", "setup", server.url, "the-code"], env, { bundle: bundle() });

  const config = (await install.pairing())!;
  expect({ exitCode: run.exitCode, last: lastLine(run.output) }, nodeLog(install)).toEqual({
    exitCode: 4, last: `Node not connected: ${server.url} refused it (Node revoked: ${config.nodeId}). Pair this machine again: ${install.paths.launcher} node pair --force ${server.url} <code>`,
  });
  // The code was just used to pair: setup does not try it again.
  expect(server.pairings).toEqual(["the-code"]);
}, 60_000);

test("run again with a new code for a home whose node the server no longer serves (it was removed), setup pairs it again with that code", async () => {
  const server = reinsServer(["first-code", "second-code"]);
  const { install, env } = nodeHome();
  const reinsJs = bundle();
  expect((await reins(["node", "setup", server.url, "first-code"], env, { bundle: reinsJs })).exitCode, nodeLog(install)).toBe(0);
  const removed = (await install.pairing())!.nodeId;
  // Removed on the server: its link closes, and the node is refused from then on.
  server.remove(removed);
  await install.stop();

  const run = await reins(["node", "setup", server.url, "second-code"], env, { bundle: reinsJs });

  const config = (await install.pairing())!;
  const status = install.status()!;
  expect({ exitCode: run.exitCode, last: lastLine(run.output) }, run.output + nodeLog(install)).toEqual({
    exitCode: 0, last: `Node "laptop" (${config.nodeId}) connected to ${server.url} (pid ${status.pid}).`,
  });
  expect(run.stdout).toContain(`${server.url} refused node ${removed} (Not authenticated); pairing this machine again with the code given`);
  expect({ renamed: config.nodeId !== removed, pairings: server.pairings }).toEqual({ renamed: true, pairings: ["first-code", "second-code"] });
  expect(run.output).not.toContain("second-code");
}, 60_000);

test("run again for a home whose node the server cannot serve as installed (another Bun), setup does not pair it again: exit 4 with the server's message", async () => {
  const server = reinsServer(["first-code", "second-code"]);
  const { install, env } = nodeHome();
  const reinsJs = bundle();
  expect((await reins(["node", "setup", server.url, "first-code"], env, { bundle: reinsJs })).exitCode, nodeLog(install)).toBe(0);
  await install.stop();
  server.answerWith("bun");

  const run = await reins(["node", "setup", server.url, "second-code"], env, { bundle: reinsJs });

  expect({ exitCode: run.exitCode, last: lastLine(run.output) }, run.output + nodeLog(install)).toEqual({ exitCode: 4, last: `Node not connected: ${server.url} refused it: ${NEEDS_BUN}` });
  expect(server.pairings).toEqual(["first-code"]);
}, 60_000);

test("status and stop follow the node setup started: connected, then stopped, its pid gone", async () => {
  const server = reinsServer(["the-code"]);
  const { home, install, env } = nodeHome();
  expect((await reins(["node", "setup", server.url, "the-code"], env, { bundle: bundle() })).exitCode, nodeLog(install)).toBe(0);
  const { pid, since, buildId } = install.status()!;
  const { nodeId } = (await install.pairing())!;

  const status = await reins(["node", "status"], env);
  expect({ exitCode: status.exitCode, stdout: status.stdout }).toEqual({
    exitCode: 0,
    stdout: [
      `Paired with ${server.url} as node ${nodeId}`,
      `Build: ${buildId}`,
      `Log: ${join(home, "logs", "node.log")}`,
      `Running (pid ${pid}), connected to ${server.url} since ${since}.`,
      "",
    ].join("\n"),
  });

  const stop = await reins(["node", "stop"], env);
  expect({ exitCode: stop.exitCode, last: lastLine(stop.stdout), running: alive(pid) }).toEqual({ exitCode: 0, last: `Node stopped (pid ${pid}).`, running: false });
  expect(nodeLog(install).trimEnd().split("\n").at(-1)).toBe("[node] stopped");

  const after = await reins(["node", "status"], env);
  expect({ exitCode: after.exitCode, last: lastLine(after.stdout) }).toEqual({ exitCode: 3, last: `Not running (last stopped at ${install.status()!.since}). Start it: ${install.paths.launcher} node start` });
}, 60_000);

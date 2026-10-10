import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRpcPeer, createWebSocketLink, generateNodeKeyPair, helloParams, NODE_REFUSED, protocolVersion, readyResult, RpcFailure, type Hello, type WebSocketLink } from "@reins/node-protocol";
import { z } from "zod";
import { lastLine, reins } from "../testing/reins.js";
import { processStartTime, readNodeStatus, stopNode } from "./background.js";
import { readNodeConfig, saveNodeIdentity } from "./config.js";
import { bundleBuildId, launcherPath } from "./install.js";

const CLI = join(import.meta.dir, "../cli.ts");
const COMMAND = join(import.meta.dir, "../command.ts");

const servers: { stop(force?: boolean): unknown }[] = [];
const homes: string[] = [];
const temps: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await stopNode(home, 5_000);
  for (const server of servers.splice(0)) server.stop(true);
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}

/** A node home whose Bun is this one, and the environment of commands run in it. */
function nodeHome() {
  const home = tempDir("reins-node-setup-");
  homes.push(home);
  symlinkSync(process.execPath, join(home, "bun"));
  return { home, env: { REINS_NODE_DATA_DIR: home, HOME: tempDir("reins-node-setup-user-"), PATH: process.env.PATH } };
}

/** A stand-in for the node bundle: a file elsewhere that runs this CLI's source as the bundle's entry does,
 * telling it the bundle it runs from. `variant` makes another build. */
function bundle(variant = "") {
  const path = join(tempDir("reins-node-bundle-"), "reins.js");
  writeFileSync(path, [
    `// ${variant}`,
    `import { runCli } from ${JSON.stringify(CLI)};`,
    `import { processContext } from ${JSON.stringify(COMMAND)};`,
    "process.exit(await runCli(process.argv.slice(2), { ...processContext(), bundle: import.meta.path }));",
  ].join("\n"));
  return path;
}

interface LinkData { wire?: WebSocketLink }
const linkData: LinkData = {};
/** A Reins server as setup meets it: `POST /api/nodes/pair` redeems each of `codes` once (for a node named
 * "laptop"), and `/node-link` answers every hello as `answer` does (it does not challenge the node). */
function reinsServer(codes: string[], answer: "ready" | "refuse" = "ready") {
  const unused = new Set(codes);
  const pairings: string[] = [];
  const hellos: Hello[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request, bunServer) {
      const { pathname } = new URL(request.url);
      if (pathname === "/node-link") return bunServer.upgrade(request, { data: {} }) ? undefined : new Response("Upgrade required", { status: 426 });
      if (request.method !== "POST" || pathname !== "/api/nodes/pair") return Response.json({ error: "Not found" }, { status: 404 });
      const { code } = z.object({ code: z.string() }).parse(await request.json());
      pairings.push(code);
      if (!unused.delete(code)) return Response.json({ error: "Invalid or expired pairing code" }, { status: 403 });
      return Response.json({ nodeId: randomUUID(), name: "laptop" }, { status: 201 });
    },
    websocket: {
      data: linkData,
      open(ws) {
        const wire = createWebSocketLink({ send: text => ws.send(text), bufferedAmount: () => ws.getBufferedAmount(), close: (code, reason) => ws.close(code, reason) }, { maxFrameBytes: 1024 * 1024 });
        ws.data.wire = wire;
        const peer = createRpcPeer(wire, {
          "node.hello": {
            params: helloParams, result: readyResult,
            handle: async (hello: Hello) => {
              hellos.push(hello);
              if (answer === "refuse") throw new RpcFailure(NODE_REFUSED, `Node revoked: ${hello.nodeId}`);
              return { version: protocolVersion, capabilities: [], epoch: randomUUID() };
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
  return { url: `http://127.0.0.1:${server.port}`, pairings, hellos };
}

const nodeLog = (home: string) => existsSync(join(home, "logs", "node.log")) ? readFileSync(join(home, "logs", "node.log"), "utf8") : "(no log)";

test("from source, setup refuses: it installs the bundle it runs from", async () => {
  const server = reinsServer(["the-code"]);
  const { home, env } = nodeHome();

  const run = await reins(["node", "setup", server.url, "the-code"], env);

  expect({ exitCode: run.exitCode, last: lastLine(run.stderr) }).toEqual({
    exitCode: 1, last: `Not set up: reins node setup installs the node bundle it runs from, and this is not one. Install with: curl -fsSL ${server.url}/nodes/install | sh -s -- <code>; from source, use reins node pair and reins node run`,
  });
  expect({ pairings: server.pairings, current: existsSync(join(home, "current")) }).toEqual({ pairings: [], current: false });
});

test("a source that is not a directory, or a home paired with another server, is refused before anything changes or the code is sent", async () => {
  const server = reinsServer(["the-code"]);
  const { home, env } = nodeHome();
  const missing = join(home, "no-such-checkout");

  const notADirectory = await reins(["node", "setup", server.url, "the-code", "--source", missing], env, { bundle: bundle() });
  expect({ exitCode: notADirectory.exitCode, last: lastLine(notADirectory.stderr) }).toEqual({ exitCode: 1, last: `Not set up: ${missing} is not a directory` });

  await saveNodeIdentity(home, { serverUrl: "http://other.example:3100", nodeId: "laptop", privateKey: generateNodeKeyPair().privateKey });
  const pairedElsewhere = await reins(["node", "setup", server.url, "the-code"], env, { bundle: bundle() });
  expect({ exitCode: pairedElsewhere.exitCode, last: lastLine(pairedElsewhere.stderr) }).toEqual({
    exitCode: 3,
    last: `Not set up: this machine's node is paired with http://other.example:3100 (${join(home, "node.json")}); the code was not used. To pair it with ${server.url} instead: reins node pair --force ${server.url} <code>, then run the install command again`,
  });

  expect({ pairings: server.pairings, current: existsSync(join(home, "current")), output: notADirectory.output + pairedElsewhere.output })
    .toEqual({ pairings: [], current: false, output: expect.not.stringContaining("the-code") });
});

test("setup makes its build current, writes the launcher, pairs, declares the sources and starts the node in the background until it connects; run again with the used code, it neither pairs again nor starts another node", async () => {
  const server = reinsServer(["the-code"]);
  const { home, env } = nodeHome();
  const checkout = tempDir("reins-node-checkout-");
  const reinsJs = bundle();
  const buildId = await bundleBuildId(reinsJs);

  const first = await reins(["node", "setup", server.url, "the-code", "--source", checkout], env, { bundle: reinsJs });

  const config = (await readNodeConfig(home))!;
  const status = readNodeStatus(home)!;
  expect({ exitCode: first.exitCode, last: lastLine(first.output) }, nodeLog(home)).toEqual({
    exitCode: 0, last: `Node "laptop" (${config.nodeId}) connected to ${server.url} (pid ${status.pid}).`,
  });
  expect(first.stdout).toContain(`Source added: ${checkout}`);
  expect({ sources: config.sources, current: readlinkSync(join(home, "current")), launcher: existsSync(launcherPath(home)) })
    .toEqual({ sources: [checkout], current: join("builds", buildId), launcher: true });
  expect(status).toMatchObject({ state: "connected", buildId, serverUrl: server.url });
  expect(server.hellos.map(hello => ({ nodeId: hello.nodeId, sources: hello.sources }))).toEqual([{ nodeId: config.nodeId, sources: [checkout] }]);

  const again = await reins(["node", "setup", server.url, "the-code", "--source", checkout], env, { bundle: reinsJs });

  expect({ exitCode: again.exitCode, last: lastLine(again.output) }).toEqual({ exitCode: 0, last: `Node ${config.nodeId} connected to ${server.url} (pid ${status.pid}).` });
  expect(again.stdout).toContain(`Already paired with ${server.url} as node ${config.nodeId}; the code was not used.`);
  expect(again.stdout).toContain(`Already a source: ${checkout}`);
  expect(again.stdout).toContain(`The node is already running this build (pid ${status.pid})`);
  expect({ pairings: server.pairings.length, hellos: server.hellos.length }).toEqual({ pairings: 1, hellos: 1 });
  expect(first.output + again.output).not.toContain("the-code");
}, 60_000);

test("setup from a newer build stops the node running the older one and starts it on the new one", async () => {
  const server = reinsServer(["the-code"]);
  const { home, env } = nodeHome();
  expect((await reins(["node", "setup", server.url, "the-code"], env, { bundle: bundle("first") })).exitCode, nodeLog(home)).toBe(0);
  const old = readNodeStatus(home)!;
  const newer = bundle("second");
  const newerId = await bundleBuildId(newer);

  const run = await reins(["node", "setup", server.url, "the-code"], env, { bundle: newer });

  const status = readNodeStatus(home)!;
  expect({ exitCode: run.exitCode, last: lastLine(run.output) }, nodeLog(home)).toEqual({ exitCode: 0, last: expect.stringContaining(`connected to ${server.url} (pid ${status.pid}).`) });
  expect(run.stdout).toContain(`Stopping the node running build ${old.buildId!.slice(0, 12)} (pid ${old.pid})`);
  expect({ oldRunning: processStartTime(old.pid) === old.started, buildId: status.buildId, current: readlinkSync(join(home, "current")), hellos: server.hellos.length })
    .toEqual({ oldRunning: false, buildId: newerId, current: join("builds", newerId), hellos: 2 });
}, 60_000);

test("a node the server refuses ends setup's wait with exit 4 and the hint to pair again", async () => {
  const server = reinsServer(["the-code"], "refuse");
  const { home, env } = nodeHome();

  const run = await reins(["node", "setup", server.url, "the-code"], env, { bundle: bundle() });

  const config = (await readNodeConfig(home))!;
  expect({ exitCode: run.exitCode, last: lastLine(run.output) }, nodeLog(home)).toEqual({
    exitCode: 4, last: `Node not connected: ${server.url} refused it (Node revoked: ${config.nodeId}). Pair this machine again: ${launcherPath(home)} node pair --force ${server.url} <code>`,
  });
}, 60_000);

test("status and stop follow the node setup started: connected, then stopped, its pid gone", async () => {
  const server = reinsServer(["the-code"]);
  const { home, env } = nodeHome();
  mkdirSync(join(home, "checkout"));
  expect((await reins(["node", "setup", server.url, "the-code", "--source", join(home, "checkout")], env, { bundle: bundle() })).exitCode, nodeLog(home)).toBe(0);
  const { pid, started, since, buildId } = readNodeStatus(home)!;
  const { nodeId } = (await readNodeConfig(home))!;

  const status = await reins(["node", "status"], env);
  expect({ exitCode: status.exitCode, stdout: status.stdout }).toEqual({
    exitCode: 0,
    stdout: [
      `Paired with ${server.url} as node ${nodeId}`,
      `Sources: ${join(home, "checkout")}`,
      `Build: ${buildId}`,
      `Log: ${join(home, "logs", "node.log")}`,
      `Running (pid ${pid}), connected to ${server.url} since ${since}.`,
      "",
    ].join("\n"),
  });

  const stop = await reins(["node", "stop"], env);
  expect({ exitCode: stop.exitCode, last: lastLine(stop.stdout), running: processStartTime(pid) === started }).toEqual({ exitCode: 0, last: `Node stopped (pid ${pid}).`, running: false });
  expect(nodeLog(home).trimEnd().split("\n").at(-1)).toBe("[node] stopped");

  const after = await reins(["node", "status"], env);
  expect({ exitCode: after.exitCode, last: lastLine(after.stdout) }).toEqual({ exitCode: 3, last: `Not running (last stopped at ${readNodeStatus(home)!.since}). Start it: ${launcherPath(home)} node start` });
}, 60_000);

/**
 * Process-level: the server-only and node-only entrypoints as real child processes, meeting only on the
 * local Unix socket. See node-contract.md *Process model*.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Child, createProcessLayout, filesUnder, ServerApi, startNodeProcess, startServer, until, type ProcessLayout } from "./helpers/processes.js";

const cleanups: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).toReversed()) await cleanup(); });
async function layout(): Promise<ProcessLayout> {
  const created = await createProcessLayout();
  cleanups.push(() => created.dispose());
  return created;
}
function track<T extends Child>(child: T): T {
  cleanups.push(() => child.stop("SIGKILL"));
  return child;
}
const CONNECTED = /\[node\] connected to server/;

test("server-only and node-only processes link over the socket, provision and prompt end to end, and never open each other's storage; the node starts first and waits for the server", async () => {
  const dirs = await layout();
  // Startup ordering: the node may start before the server's socket exists; it redials.
  const node = track(startNodeProcess(dirs));
  await node.waitFor(/\[node\] dialing server/);
  await Bun.sleep(300);
  expect(node.count(CONNECTED)).toBe(0);
  const server = track(await startServer(dirs));
  await node.waitFor(CONNECTED);
  await server.waitFor(/Internal node connected/);
  const api = new ServerApi(server.port);
  expect(await api.health()).toMatchObject({ status: "ok", internalNode: { connected: true } });

  const { projectId } = await api.setUp(dirs.repo.dir);
  const sessionId = await api.createSession(projectId);
  await api.prompt(sessionId, "first", "Hello node");
  await api.waitForTranscript(sessionId, ["user: Hello node", "assistant: Echo: Hello node"]);
  await until(async () => await api.activity(sessionId) === "finished", "settled");

  // Graceful stops: SIGTERM exits 0 on both sides.
  expect(await node.stop("SIGTERM")).toBe(0);
  expect(node.output).toContain("[node] stopped");
  expect(await server.stop("SIGTERM")).toBe(0);
  expect(existsSync(dirs.socket)).toBe(false);

  // Storage separation, checked on disk: each process wrote only its own database.
  expect((await filesUnder(dirs.dataDir)).filter(file => file.endsWith(".db"))).toEqual(["reins.db"]);
  expect((await filesUnder(dirs.nodeHome)).filter(file => file.endsWith(".db"))).toEqual([join(".reins", "node", "storage.db")]);
  expect((await filesUnder(dirs.serverHome)).filter(file => file.endsWith(".db") || file.includes(".reins"))).toEqual([]);
  expect(await filesUnder(dirs.nodeCwd)).toEqual([]);
}, 60_000);

test("a node killed mid-run restarts with its disk intact, reconnects, and the session continues without duplicates", async () => {
  const dirs = await layout();
  const server = track(await startServer(dirs));
  let node = track(startNodeProcess(dirs));
  await node.waitFor(CONNECTED);
  const api = new ServerApi(server.port);
  const { projectId } = await api.setUp(dirs.repo.dir);
  const sessionId = await api.createSession(projectId);
  await api.prompt(sessionId, "first", "One");
  await api.waitForTranscript(sessionId, ["user: One", "assistant: Echo: One"]);

  // A run in flight when the node dies: the user message is committed, the reply never arrives.
  await api.prompt(sessionId, "slow", "Two [slow:3000]");
  await api.waitForTranscript(sessionId, ["user: Two [slow:3000]"]);
  await node.stop("SIGKILL");
  await until(async () => !(await api.health()).internalNode.connected, "server sees the node gone");

  node = track(startNodeProcess(dirs));
  await node.waitFor(CONNECTED);
  // Pi left the killed run pending with an unknown outcome; nothing runs it again implicitly (crash
  // recovery of `running` activity is open). The existing explicit resume continues it.
  await api.json("POST", `/api/sessions/${sessionId}/resume`);
  await api.waitForTranscript(sessionId, ["assistant: Echo: Two [slow:3000]"]);
  await until(async () => await api.activity(sessionId) === "finished", "resumed run settled");
  await api.prompt(sessionId, "third", "Three");
  const transcript = await api.waitForTranscript(sessionId, ["user: Three", "assistant: Echo: Three"], 30_000);
  await until(async () => await api.activity(sessionId) === "finished", "settled");
  for (const entry of ["user: One", "assistant: Echo: One", "user: Two [slow:3000]", "user: Three", "assistant: Echo: Three"]) {
    expect(transcript.filter(line => line === entry)).toHaveLength(1);
  }
  expect(transcript.filter(line => line === "assistant: Echo: Two [slow:3000]").length).toBeLessThanOrEqual(1);
}, 90_000);

test("a server restarted while the node runs: the node redials, replays what it committed offline, and the session continues", async () => {
  const dirs = await layout();
  let server = track(await startServer(dirs));
  const node = track(startNodeProcess(dirs));
  await node.waitFor(CONNECTED);
  let api = new ServerApi(server.port);
  const { projectId } = await api.setUp(dirs.repo.dir);
  const sessionId = await api.createSession(projectId);
  await api.prompt(sessionId, "first", "One");
  await api.waitForTranscript(sessionId, ["user: One", "assistant: Echo: One"]);

  // The run finishes while the server is down: its reply and settlement wait in the node outbox.
  await api.prompt(sessionId, "slow", "Two [slow:1500]");
  await api.waitForTranscript(sessionId, ["user: Two [slow:1500]"]);
  expect(await server.stop("SIGTERM")).toBe(0);
  await node.waitFor(/\[node\] disconnected from server/);
  await Bun.sleep(2_000);
  expect(node.proc.exitCode).toBeNull();

  server = track(await startServer(dirs));
  api = new ServerApi(server.port);
  await node.waitFor(CONNECTED, 2);
  await api.waitForTranscript(sessionId, ["user: Two [slow:1500]", "assistant: Echo: Two [slow:1500]"]);
  await until(async () => await api.activity(sessionId) === "finished", "replayed settlement");
  await api.prompt(sessionId, "third", "Three");
  const transcript = await api.waitForTranscript(sessionId, ["user: Three", "assistant: Echo: Three"]);
  expect(transcript).toEqual(["user: One", "assistant: Echo: One", "user: Two [slow:1500]", "assistant: Echo: Two [slow:1500]", "user: Three", "assistant: Echo: Three"]);
}, 90_000);

test("server handler hot reload hands the socket link to the new handler without aborting the node's run, and in-flight work converges once", async () => {
  const dirs = await layout();
  const server = track(await startServer(dirs, { REINS_DEV: "1" }));
  const node = track(startNodeProcess(dirs));
  await node.waitFor(CONNECTED);
  const api = new ServerApi(server.port);
  const { projectId } = await api.setUp(dirs.repo.dir);
  const sessionId = await api.createSession(projectId);
  await api.prompt(sessionId, "first", "One");
  await api.waitForTranscript(sessionId, ["user: One", "assistant: Echo: One"]);

  // A run is active on the node when the server's handlers reload.
  await api.prompt(sessionId, "slow", "Two [slow:3000]");
  await api.waitForTranscript(sessionId, ["user: Two [slow:3000]"]);
  // The dev reload path (what a source change triggers): rebuild and reinstall the handlers in the
  // running server process. SIGUSR2 avoids touching the checkout's files.
  server.proc.kill("SIGUSR2");
  await server.waitFor(/\[hot reload\].*reloaded on SIGUSR2/);
  expect(await api.transcript(sessionId)).not.toContain("assistant: Echo: Two [slow:3000]"); // still running
  // Queued while the old link is closed and before the node has redialed the new handler: a steer
  // into the run still active on the node.
  await api.prompt(sessionId, "during", "Three", "steer");
  await node.waitFor(CONNECTED, 2);
  expect(node.count(/\[node\] disconnected from server/)).toBe(1);

  const transcript = await api.waitForTranscript(sessionId, ["user: Three", "assistant: Echo: Three"], 30_000);
  expect(transcript).toEqual(["user: One", "assistant: Echo: One", "user: Two [slow:3000]", "assistant: Echo: Two [slow:3000]", "user: Three", "assistant: Echo: Three"]);
  await until(async () => await api.activity(sessionId) === "finished", "settled");
  expect(node.count(/\[node\] (?:received|stopped)/)).toBe(0);
  // A clean exit also removes this dev server's own bundle directory.
  const bundle = new URL(`../../.dev-build/${server.proc.pid}`, import.meta.url).pathname;
  expect(existsSync(bundle)).toBe(true);
  expect(await server.stop("SIGTERM")).toBe(0);
  expect(existsSync(bundle)).toBe(false);
}, 90_000);

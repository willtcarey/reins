/**
 * Process-level: the server-only and node-only entrypoints as real child processes, meeting only on the
 * local Unix socket. See node-contract.md *Process model*.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { createProcessLayout, filesUnder, ServerApi, startNodeProcess, startServer, stopChildren, until, type ProcessLayout } from "./helpers/processes.js";

const cleanups: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  await stopChildren();
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});
async function layout(): Promise<ProcessLayout> {
  const created = await createProcessLayout();
  cleanups.push(() => created.dispose());
  return created;
}
const CONNECTED = /\[node\] connected to server/;

test("server-only and node-only processes link over the socket and prompt end to end; only the server stores anything; the node starts first and waits for the server", async () => {
  const dirs = await layout();
  // Startup ordering: the node may start before the server's socket exists; it redials.
  const node = startNodeProcess(dirs);
  await node.waitFor(/\[node\] dialing server/);
  await Bun.sleep(300);
  expect(node.count(CONNECTED)).toBe(0);
  const server = await startServer(dirs);
  await node.waitFor(CONNECTED);
  await server.waitFor(/Node internal connected/);
  const api = new ServerApi(server.port);
  expect(await api.health()).toMatchObject({ status: "ok", nodes: [{ id: "internal", name: "Internal", connected: true }] });

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

  // Checked on disk: the server's database is the only one; the node holds no session state (ADR-015).
  expect((await filesUnder(dirs.dataDir)).filter(file => file.endsWith(".db"))).toEqual(["reins.db"]);
  expect((await filesUnder(dirs.nodeHome)).filter(file => file.endsWith(".db"))).toEqual([]);
  expect((await filesUnder(dirs.serverHome)).filter(file => file.endsWith(".db") || file.includes(".reins"))).toEqual([]);
  expect(await filesUnder(dirs.nodeCwd)).toEqual([]);
}, 60_000);

test("a node killed mid-run restarts and reconnects; the server settles the lost run as interrupted, and the session continues without duplicates", async () => {
  const dirs = await layout();
  const server = await startServer(dirs);
  let node = startNodeProcess(dirs);
  await node.waitFor(CONNECTED);
  const api = new ServerApi(server.port);
  const { projectId } = await api.setUp(dirs.repo.dir);
  const sessionId = await api.createSession(projectId);
  await api.prompt(sessionId, "first", "One");
  await api.waitForTranscript(sessionId, ["user: One", "assistant: Echo: One"]);
  await until(async () => await api.activity(sessionId) === "finished", "first run settled");

  // A run in flight when the node dies: the user message is committed, the reply never arrives.
  await api.prompt(sessionId, "slow", "Two [slow:3000]");
  await api.waitForTranscript(sessionId, ["user: Two [slow:3000]"]);
  await node.waitFor(/\[node\] faux provider waiting for 3000ms/);
  await node.stop("SIGKILL");
  await until(async () => !(await api.localNodeConnected()), "server sees the node gone");

  node = startNodeProcess(dirs);
  await node.waitFor(CONNECTED);
  // The restarted node lists no live run in its hello, so the server settles the lost one as interrupted.
  await until(async () => await api.activity(sessionId) === "finished", "interrupted run settled");
  // Pi left the killed run pending in the server's copy; nothing runs it again implicitly. The explicit
  // resume continues it.
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

test("a server restarted while the node runs: the run's commits wait for the node to reconnect and the run finishes over the new link", async () => {
  const dirs = await layout();
  let server = await startServer(dirs);
  const node = startNodeProcess(dirs);
  await node.waitFor(CONNECTED);
  let api = new ServerApi(server.port);
  const { projectId } = await api.setUp(dirs.repo.dir);
  const sessionId = await api.createSession(projectId);
  await api.prompt(sessionId, "first", "One");
  await api.waitForTranscript(sessionId, ["user: One", "assistant: Echo: One"]);
  await until(async () => await api.activity(sessionId) === "finished", "first run settled");

  // The reply is ready while the server is down: its commit waits for the node to reconnect.
  await api.prompt(sessionId, "slow", "Two [slow:1500]");
  await api.waitForTranscript(sessionId, ["user: Two [slow:1500]"]);
  // Admission alone does not prove the node has finished its opening storage calls. Interrupt while
  // the provider is actually waiting, so this exercises unsent commits waiting for reconnection.
  await node.waitFor(/\[node\] faux provider waiting for 1500ms/);
  expect(await server.stop("SIGTERM")).toBe(0);
  await node.waitFor(/\[node\] disconnected from server/);
  await Bun.sleep(2_000);
  expect(node.proc.exitCode).toBeNull();

  server = await startServer(dirs);
  api = new ServerApi(server.port);
  await node.waitFor(CONNECTED, 2);
  // The node's hello lists the run as live, so the server leaves it running; it commits and settles.
  await api.waitForTranscript(sessionId, ["assistant: Echo: Two [slow:1500]"]);
  await until(async () => await api.activity(sessionId) === "finished", "run settled");
  await api.prompt(sessionId, "third", "Three");
  const transcript = await api.waitForTranscript(sessionId, ["user: Three", "assistant: Echo: Three"]);
  expect(transcript).toEqual(["user: One", "assistant: Echo: One", "user: Two [slow:1500]", "assistant: Echo: Two [slow:1500]", "user: Three", "assistant: Echo: Three"]);
}, 90_000);

test("a dev reload drops the node link and the node redials the new hub; the run in flight commits and settles over the new link, and a browser socket opened before the reload submits input after it", async () => {
  const dirs = await layout();
  const server = await startServer(dirs, { REINS_DEV: "1" });
  const node = startNodeProcess(dirs);
  await node.waitFor(CONNECTED);
  const api = new ServerApi(server.port);
  const { projectId } = await api.setUp(dirs.repo.dir);
  const sessionId = await api.createSession(projectId);
  await api.prompt(sessionId, "first", "One");
  await api.waitForTranscript(sessionId, ["user: One", "assistant: Echo: One"]);
  await until(async () => await api.activity(sessionId) === "finished", "first run settled");

  // A browser stays connected across the reload: the socket is the process's, not the handler load's.
  const browser = await api.connect();
  cleanups.push(() => browser.close());
  // A run is active on the node when the server reloads. SIGUSR2 is the dev reload path a source change
  // triggers, without touching the checkout's files.
  await browser.prompt(sessionId, "slow", "Two [slow:3000]");
  await api.waitForTranscript(sessionId, ["user: Two [slow:3000]"]);
  await node.waitFor(/\[node\] faux provider waiting for 3000ms/);
  server.proc.kill("SIGUSR2");
  await server.waitFor(/\[hot reload\].*reloaded on SIGUSR2/);
  await node.waitFor(/\[node\] disconnected from server/);
  await node.waitFor(CONNECTED, 2);
  // The node's hello listed the run as live, so the new hub left it running.
  expect(await api.activity(sessionId)).toBe("running");
  expect(await api.transcript(sessionId)).not.toContain("assistant: Echo: Two [slow:3000]");
  await browser.prompt(sessionId, "during", "Three", "steer");

  const transcript = await api.waitForTranscript(sessionId, ["user: Three", "assistant: Echo: Three"], 30_000);
  expect(transcript).toEqual(["user: One", "assistant: Echo: One", "user: Two [slow:3000]", "assistant: Echo: Two [slow:3000]", "user: Three", "assistant: Echo: Three"]);
  await until(async () => await api.activity(sessionId) === "finished", "settled");
  expect(node.count(CONNECTED)).toBe(2);
  expect(node.count(/\[node\] disconnected from server/)).toBe(1);
  expect(node.count(/\[node\] (?:received|stopped)/)).toBe(0);
  // A clean exit also removes this dev server's own bundle directory.
  const bundle = new URL(`../../.dev-build/${server.proc.pid}`, import.meta.url).pathname;
  expect(existsSync(bundle)).toBe(true);
  expect(await server.stop("SIGTERM")).toBe(0);
  expect(existsSync(bundle)).toBe(false);
  expect(existsSync(dirs.socket)).toBe(false);
}, 90_000);

test("a dev reload while a command is dispatching requeues it and delivers it once over the new link; the new load opens the database only after the old one settled its delivery", async () => {
  const dirs = await layout();
  const server = await startServer(dirs, { REINS_DEV: "1" });
  const node = startNodeProcess(dirs);
  await node.waitFor(CONNECTED);
  const api = new ServerApi(server.port);
  const { projectId } = await api.setUp(dirs.repo.dir);
  const sessionId = await api.createSession(projectId);
  await api.prompt(sessionId, "first", "One");
  await api.waitForTranscript(sessionId, ["user: One", "assistant: Echo: One"]);
  await until(async () => await api.activity(sessionId) === "finished", "first run settled");
  const DATABASE_OPENED = /Database: .*reins\.db/;
  expect(server.count(DATABASE_OPENED)).toBe(1);

  // A frozen node holds the prompt's delivery in flight (`dispatching`) when the server reloads.
  const db = new Database(join(dirs.dataDir, "reins.db"), { readonly: true });
  cleanups.push(() => db.close());
  const outbox = () => db.query<{ state: string }, [string]>("SELECT state FROM node_command_outbox WHERE session_id = ?").all(sessionId).map(row => row.state);
  node.proc.kill("SIGSTOP");
  await api.prompt(sessionId, "frozen", "Two");
  await until(() => outbox().includes("dispatching"), "prompt dispatching");

  server.proc.kill("SIGUSR2");
  await server.waitFor(/\[hot reload\].*reloaded on SIGUSR2/);
  // Closing the old link left the delivery's outcome unknown, so the old load requeued it in place before
  // it closed its database; the new load opened the database after that, with nothing left to recover.
  await until(() => outbox().join() === "queued", "prompt requeued");
  expect(server.count(DATABASE_OPENED)).toBe(2);
  expect(server.count(/\(0 interrupted dispatches recovered\)/)).toBe(2);
  // Input submitted while the node is away waits in the outbox behind it.
  await api.prompt(sessionId, "behind", "Three", "steer");
  expect(outbox()).toEqual(["queued", "queued"]);

  // The node resumes (it may admit the frame it already received before it sees the old link gone),
  // redials the new hub, and the replay converges: each prompt is in the transcript once and runs once.
  node.proc.kill("SIGCONT");
  await node.waitFor(CONNECTED, 2);
  await api.waitForTranscript(sessionId, ["user: Three", "assistant: Echo: Three"], 30_000);
  await until(() => outbox().length === 0, "commands settled");
  await until(async () => await api.activity(sessionId) === "finished", "settled");
  // Three steers Two's run, possibly before its first reply: each input is in the transcript once.
  const transcript = await api.transcript(sessionId);
  expect(transcript.filter(line => line.startsWith("user: "))).toEqual(["user: One", "user: Two", "user: Three"]);
  expect(transcript.at(-1)).toBe("assistant: Echo: Three");
  expect(server.count(DATABASE_OPENED)).toBe(2);
}, 90_000);

test("a server killed while a prompt is being delivered requeues it at startup, and the restarted server delivers it once", async () => {
  const dirs = await layout();
  let server = await startServer(dirs);
  const node = startNodeProcess(dirs);
  await node.waitFor(CONNECTED);
  let api = new ServerApi(server.port);
  const { projectId } = await api.setUp(dirs.repo.dir);
  const sessionId = await api.createSession(projectId);
  await api.prompt(sessionId, "first", "One");
  await api.waitForTranscript(sessionId, ["user: One", "assistant: Echo: One"]);
  await until(async () => await api.activity(sessionId) === "finished", "first run settled");

  // A frozen node holds the prompt's delivery in flight (`dispatching`) when the server dies.
  const db = new Database(join(dirs.dataDir, "reins.db"), { readonly: true });
  cleanups.push(() => db.close());
  const outbox = () => db.query<{ state: string }, [string]>("SELECT state FROM node_command_outbox WHERE session_id = ?").all(sessionId).map(row => row.state);
  node.proc.kill("SIGSTOP");
  await api.prompt(sessionId, "in-flight", "Two");
  await until(() => outbox().includes("dispatching"), "prompt dispatching");
  await server.stop("SIGKILL");

  // Startup recovery requeues it in place; the session keeps its placement.
  server = await startServer(dirs);
  api = new ServerApi(server.port);
  await server.waitFor(/\(1 interrupted dispatch recovered\)/);
  expect(outbox()).toEqual(["queued"]);

  // The node resumes (it may admit the frame it already received before it sees the old link gone),
  // redials, and the replay converges: the prompt is in the transcript once and runs once.
  node.proc.kill("SIGCONT");
  await node.waitFor(CONNECTED, 2);
  await api.waitForTranscript(sessionId, ["user: Two", "assistant: Echo: Two"], 30_000);
  await until(() => outbox().length === 0, "command settled");
  await until(async () => await api.activity(sessionId) === "finished", "settled");
  expect(await api.transcript(sessionId)).toEqual(["user: One", "assistant: Echo: One", "user: Two", "assistant: Echo: Two"]);
}, 90_000);

/**
 * Process-level: the server-only and node-only entrypoints as real child processes, meeting only on the
 * local Unix socket. See node-contract.md *Process model*.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
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

test("server-only and node-only processes link over the socket and prompt end to end; only the server stores anything; the node starts first and waits for the server", async () => {
  const dirs = await layout();
  // Startup ordering: the node may start before the server's socket exists; it redials.
  const node = track(startNodeProcess(dirs));
  await node.waitFor(/\[node\] dialing server/);
  await Bun.sleep(300);
  expect(node.count(CONNECTED)).toBe(0);
  const server = track(await startServer(dirs));
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
  const server = track(await startServer(dirs));
  let node = track(startNodeProcess(dirs));
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

  node = track(startNodeProcess(dirs));
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
  let server = track(await startServer(dirs));
  const node = track(startNodeProcess(dirs));
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

  server = track(await startServer(dirs));
  api = new ServerApi(server.port);
  await node.waitFor(CONNECTED, 2);
  // The node's hello lists the run as live, so the server leaves it running; it commits and settles.
  await api.waitForTranscript(sessionId, ["assistant: Echo: Two [slow:1500]"]);
  await until(async () => await api.activity(sessionId) === "finished", "run settled");
  await api.prompt(sessionId, "third", "Three");
  const transcript = await api.waitForTranscript(sessionId, ["user: Three", "assistant: Echo: Three"]);
  expect(transcript).toEqual(["user: One", "assistant: Echo: One", "user: Two [slow:1500]", "assistant: Echo: Two [slow:1500]", "user: Three", "assistant: Echo: Three"]);
}, 90_000);

test("server handler hot reload preserves the node link and active run; new handlers submit steering over the same connection", async () => {
  const dirs = await layout();
  const server = track(await startServer(dirs, { REINS_DEV: "1" }));
  const node = track(startNodeProcess(dirs));
  await node.waitFor(CONNECTED);
  const api = new ServerApi(server.port);
  const { projectId } = await api.setUp(dirs.repo.dir);
  const sessionId = await api.createSession(projectId);
  await api.prompt(sessionId, "first", "One");
  await api.waitForTranscript(sessionId, ["user: One", "assistant: Echo: One"]);
  await until(async () => await api.activity(sessionId) === "finished", "first run settled");

  // A run is active on the node when the server's handlers reload.
  await api.prompt(sessionId, "slow", "Two [slow:3000]");
  await api.waitForTranscript(sessionId, ["user: Two [slow:3000]"]);
  // The dev reload path (what a source change triggers): rebuild and reinstall the handlers in the
  // running server process. SIGUSR2 avoids touching the checkout's files.
  server.proc.kill("SIGUSR2");
  await server.waitFor(/\[hot reload\].*reloaded on SIGUSR2/);
  expect(await api.transcript(sessionId)).not.toContain("assistant: Echo: Two [slow:3000]"); // still running
  await api.prompt(sessionId, "during", "Three", "steer");
  expect(node.count(CONNECTED)).toBe(1);
  expect(node.count(/\[node\] disconnected from server/)).toBe(0);

  const transcript = await api.waitForTranscript(sessionId, ["user: Three", "assistant: Echo: Three"], 30_000);
  expect(transcript).toEqual(["user: One", "assistant: Echo: One", "user: Two [slow:3000]", "assistant: Echo: Two [slow:3000]", "user: Three", "assistant: Echo: Three"]);
  await until(async () => await api.activity(sessionId) === "finished", "settled");
  expect(node.count(CONNECTED)).toBe(1);
  expect(node.count(/\[node\] disconnected from server/)).toBe(0);
  expect(node.count(/\[node\] (?:received|stopped)/)).toBe(0);
  // A clean exit also removes this dev server's own bundle directory.
  const bundle = new URL(`../../.dev-build/${server.proc.pid}`, import.meta.url).pathname;
  expect(existsSync(bundle)).toBe(true);
  expect(await server.stop("SIGTERM")).toBe(0);
  expect(existsSync(bundle)).toBe(false);
}, 90_000);

test("a dev hot reload while a command is dispatching reuses the process's database: startup recovery does not run again, and the command is delivered", async () => {
  const dirs = await layout();
  const server = track(await startServer(dirs, { REINS_DEV: "1" }));
  const node = track(startNodeProcess(dirs));
  await node.waitFor(CONNECTED);
  const api = new ServerApi(server.port);
  const { projectId } = await api.setUp(dirs.repo.dir);
  const sessionId = await api.createSession(projectId);
  await api.prompt(sessionId, "first", "One");
  await api.waitForTranscript(sessionId, ["user: One", "assistant: Echo: One"]);
  await until(async () => await api.activity(sessionId) === "finished", "first run settled");
  const DATABASE_OPENED = /Database: .*reins\.db/;
  expect(server.count(DATABASE_OPENED)).toBe(1);

  // A frozen node holds the prompt's delivery in flight (`dispatching`) across the reload.
  const db = new Database(join(dirs.dataDir, "reins.db"), { readonly: true });
  cleanups.push(() => db.close());
  const outbox = () => db.query<{ state: string }, [string]>("SELECT state FROM node_command_outbox WHERE session_id = ?").all(sessionId).map(row => row.state);
  node.proc.kill("SIGSTOP");
  cleanups.push(() => { node.proc.kill("SIGCONT"); });
  await api.prompt(sessionId, "frozen", "Two");
  await until(() => outbox().includes("dispatching"), "prompt dispatching");

  server.proc.kill("SIGUSR2");
  await server.waitFor(/\[hot reload\].*reloaded on SIGUSR2/);
  // The reloaded handler opened no second connection and ran no startup recovery, which would have
  // requeued the in-flight command while the old handler was still delivering it.
  expect(server.count(DATABASE_OPENED)).toBe(1);
  expect(outbox()).toHaveLength(1);

  node.proc.kill("SIGCONT");
  await api.waitForTranscript(sessionId, ["user: Two", "assistant: Echo: Two"], 30_000);
  await until(() => outbox().length === 0, "command settled");
  expect(server.count(DATABASE_OPENED)).toBe(1);
}, 90_000);

test("a server killed while a prompt is being delivered requeues it at startup, and the restarted server delivers it once", async () => {
  const dirs = await layout();
  let server = track(await startServer(dirs));
  const node = track(startNodeProcess(dirs));
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
  cleanups.push(() => { node.proc.kill("SIGCONT"); });
  await api.prompt(sessionId, "in-flight", "Two");
  await until(() => outbox().includes("dispatching"), "prompt dispatching");
  await server.stop("SIGKILL");

  // Startup recovery requeues it in place; the session keeps its placement.
  server = track(await startServer(dirs));
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

/**
 * Process-level: the server-only and node-only entrypoints as real child processes, meeting only on the
 * local Unix socket. See node-contract.md *Process model*. Sessions run on the server (ADR-029), on its
 * test faux provider; their tools run on the node.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
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
const WAITING = (ms: number) => new RegExp(`\\[server\\] faux provider waiting for ${ms}ms`);
/** A session of a project on the layout's repo, after one exchange. */
async function sessionWithOneRun(api: ServerApi, dirs: ProcessLayout): Promise<string> {
  const { projectId } = await api.setUp(dirs.repo.dir);
  const sessionId = await api.createSession(projectId);
  await api.prompt(sessionId, "first", "One");
  await api.waitForTranscript(sessionId, ["user: One", "assistant: Echo: One"]);
  await until(async () => await api.activity(sessionId) === "finished", "first run settled");
  return sessionId;
}

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

test("a node killed mid-run does not stop the run, which runs on the server; the restarted node takes the next run's tool call", async () => {
  const dirs = await layout();
  const server = await startServer(dirs);
  let node = startNodeProcess(dirs);
  await node.waitFor(CONNECTED);
  const api = new ServerApi(server.port);
  const sessionId = await sessionWithOneRun(api, dirs);

  await api.prompt(sessionId, "slow", "Two [slow:2000]");
  await server.waitFor(WAITING(2000));
  await node.stop("SIGKILL");
  await until(async () => !(await api.localNodeConnected()), "server sees the node gone");
  await api.waitForTranscript(sessionId, ["user: Two [slow:2000]", "assistant: Echo: Two [slow:2000]"]);
  await until(async () => await api.activity(sessionId) === "finished", "run settled");

  node = startNodeProcess(dirs);
  await node.waitFor(CONNECTED);
  await api.prompt(sessionId, "third", "Three [tool]");
  const transcript = await api.waitForTranscript(sessionId, ["user: Three [tool]", "assistant: ", "assistant: Echo: Three [tool]"], 30_000);
  expect(readFileSync(join(dirs.repo.dir, "tool-runs.log"), "utf8")).toBe("ran\n");
  expect(transcript.filter(line => line.startsWith("user: "))).toEqual(["user: One", "user: Two [slow:2000]", "user: Three [tool]"]);
}, 90_000);

test("SIGTERM pauses the run at its next pause point and suspends it; the next server process resumes it, and its tool call runs once", async () => {
  const dirs = await layout();
  let server = await startServer(dirs);
  const node = startNodeProcess(dirs);
  await node.waitFor(CONNECTED);
  let api = new ServerApi(server.port);
  const sessionId = await sessionWithOneRun(api, dirs);

  // Stopped during the run's first request, which answers with a tool call: the run is held before it.
  const prompt = "Two [slow:1500] [tool]";
  await api.prompt(sessionId, "slow", prompt);
  await server.waitFor(WAITING(1500));
  expect(await server.stop("SIGTERM")).toBe(0);
  expect(server.output).toContain("Suspended 1 session runtime(s)");
  expect(server.output).not.toContain("not paused within");
  expect(existsSync(join(dirs.repo.dir, "tool-runs.log"))).toBe(false);

  server = await startServer(dirs);
  api = new ServerApi(server.port);
  await server.waitFor(new RegExp(`Session ${sessionId}'s run was interrupted; resuming it`));
  await node.waitFor(CONNECTED, 2);
  const transcript = await api.waitForTranscript(sessionId, [`assistant: Echo: ${prompt}`], 30_000);
  await until(async () => await api.activity(sessionId) === "finished", "resumed run settled");
  expect(readFileSync(join(dirs.repo.dir, "tool-runs.log"), "utf8")).toBe("ran\n");
  expect(transcript.filter(line => line === `user: ${prompt}`)).toHaveLength(1);
  expect(transcript.filter(line => line === `assistant: Echo: ${prompt}`)).toHaveLength(1);
  // The request after the tool call ran on the new process; the one before it was not asked again.
  expect(server.count(WAITING(1500))).toBe(1);
}, 90_000);

/** A session's run on a bash call running `command` (which first appends `start` to `runs.log` in the
 * checkout), its server stopped with SIGTERM while the command runs: the run is not paused (its tool call is
 * in flight) and is suspended, leaving the command running on the node. */
async function stoppedMidCommand(dirs: ProcessLayout, command: string) {
  const server = await startServer(dirs);
  const node = startNodeProcess(dirs);
  await node.waitFor(CONNECTED);
  const api = new ServerApi(server.port);
  const sessionId = await sessionWithOneRun(api, dirs);
  const prompt = `Two [bash:${command}]`;
  await api.prompt(sessionId, "bash", prompt);
  await until(() => existsSync(join(dirs.repo.dir, "runs.log")), "the command started");
  expect(await server.stop("SIGTERM")).toBe(0);
  expect(server.output).toContain("Suspending 1 session runtime(s) not paused within");
  expect(server.output).toContain("Suspended 1 session runtime(s)");
  return { node, sessionId, prompt };
}
test("a dev reload during a bash command drops the node's link: the node redials the new app, and the command, which ran on, completes through it, once", async () => {
  const dirs = await layout();
  const server = await startServer(dirs, { REINS_DEV: "1" });
  const node = startNodeProcess(dirs);
  await node.waitFor(CONNECTED);
  const api = new ServerApi(server.port);
  const sessionId = await sessionWithOneRun(api, dirs);
  const prompt = "Two [bash:echo start >> runs.log; echo started; sleep 3; echo done; echo end >> runs.log]";
  await api.prompt(sessionId, "bash", prompt);
  await until(() => existsSync(join(dirs.repo.dir, "runs.log")), "the command started");

  server.proc.kill("SIGUSR2");
  await server.waitFor(/\[hot reload\].*reloaded on SIGUSR2/);
  await node.waitFor(/\[node\] disconnected from server/);
  await node.waitFor(CONNECTED, 2);
  // Still running: the reload neither stopped nor resent it.
  expect(readFileSync(join(dirs.repo.dir, "runs.log"), "utf8")).toBe("start\n");

  await api.waitForTranscript(sessionId, [`assistant: Echo: ${prompt}`], 30_000);
  await until(async () => await api.activity(sessionId) === "finished", "settled");
  expect(readFileSync(join(dirs.repo.dir, "runs.log"), "utf8")).toBe("start\nend\n");
  expect(await api.toolResults(sessionId)).toEqual([{ text: "started\ndone\n", isError: false }]);
  expect(server.output).not.toMatch(/Suspended|resuming it/);
  expect(await server.stop("SIGTERM")).toBe(0);
}, 90_000);

const RESUMING = (sessionId: string) => new RegExp(`Session ${sessionId}'s run was interrupted; resuming it`);
const runsLog = (dirs: ProcessLayout) => readFileSync(join(dirs.repo.dir, "runs.log"), "utf8");

test("a bash command running when the server stops with SIGTERM goes on on the node: the next server process picks it up again, its tool call gets its whole output and exit, and it ran once", async () => {
  const dirs = await layout();
  const { node, sessionId, prompt } = await stoppedMidCommand(dirs, "echo start >> runs.log; echo started; sleep 8; echo done; echo end >> runs.log");
  const server = await startServer(dirs);
  const api = new ServerApi(server.port);
  await server.waitFor(RESUMING(sessionId));
  await node.waitFor(CONNECTED, 2);
  // Picked up while it still runs.
  expect(runsLog(dirs)).toBe("start\n");
  await api.waitForTranscript(sessionId, [`assistant: Echo: ${prompt}`], 30_000);
  await until(async () => await api.activity(sessionId) === "finished", "resumed run settled");
  expect(runsLog(dirs)).toBe("start\nend\n");
  expect(await api.toolResults(sessionId)).toEqual([{ text: "started\ndone\n", isError: false }]);
}, 90_000);

test("a bash command that finishes while the server is down (within the node's grace period): the next server process gets its real result", async () => {
  const dirs = await layout();
  const { sessionId, prompt } = await stoppedMidCommand(dirs, "echo start >> runs.log; echo started; sleep 5; echo done; echo end >> runs.log");
  await until(() => runsLog(dirs).includes("end"), "the command finished", 15_000);
  const server = await startServer(dirs);
  const api = new ServerApi(server.port);
  await api.waitForTranscript(sessionId, [`assistant: Echo: ${prompt}`], 30_000);
  await until(async () => await api.activity(sessionId) === "finished", "resumed run settled");
  expect(runsLog(dirs)).toBe("start\nend\n");
  expect(await api.toolResults(sessionId)).toEqual([{ text: "started\ndone\n", isError: false }]);
}, 90_000);

test("a bash command lost with its node while the server is down: the next server process tells the model its outcome is unknown, and never runs it again", async () => {
  const dirs = await layout();
  const { node, sessionId, prompt } = await stoppedMidCommand(dirs, "echo start >> runs.log; echo started; sleep 30; echo done");
  expect(await node.stop("SIGTERM")).toBe(0);
  const server = await startServer(dirs);
  startNodeProcess(dirs);
  const api = new ServerApi(server.port);
  await api.waitForTranscript(sessionId, [`assistant: Echo: ${prompt}`], 30_000);
  await until(async () => await api.activity(sessionId) === "finished", "resumed run settled");
  expect(runsLog(dirs)).toBe("start\n");
  expect(await api.toolResults(sessionId)).toEqual([{ text: expect.stringContaining("the external outcome is unknown"), isError: true }]);
}, 90_000);

test("a server killed mid-request: the next process resumes the run, asking the cut-off request again, and the session continues without duplicates", async () => {
  const dirs = await layout();
  let server = await startServer(dirs);
  const node = startNodeProcess(dirs);
  await node.waitFor(CONNECTED);
  let api = new ServerApi(server.port);
  const sessionId = await sessionWithOneRun(api, dirs);

  await api.prompt(sessionId, "slow", "Two [slow:3000]");
  await server.waitFor(WAITING(3000));
  await server.stop("SIGKILL");

  server = await startServer(dirs);
  api = new ServerApi(server.port);
  await server.waitFor(WAITING(3000));
  expect(await api.activity(sessionId)).toBe("running");
  await api.waitForTranscript(sessionId, ["assistant: Echo: Two [slow:3000]"], 30_000);
  await until(async () => await api.activity(sessionId) === "finished", "resumed run settled");
  await api.prompt(sessionId, "third", "Three");
  const transcript = await api.waitForTranscript(sessionId, ["user: Three", "assistant: Echo: Three"]);
  // Pi records the cut-off request (an empty assistant message) before asking it again.
  expect(transcript.filter(line => line !== "assistant: ")).toEqual(["user: One", "assistant: Echo: One", "user: Two [slow:3000]", "assistant: Echo: Two [slow:3000]", "user: Three", "assistant: Echo: Three"]);
}, 90_000);

test("a dev reload neither pauses nor interrupts a run: it continues on the server while the node redials the new app, and a browser socket opened before the reload submits input after it", async () => {
  const dirs = await layout();
  const server = await startServer(dirs, { REINS_DEV: "1" });
  const node = startNodeProcess(dirs);
  await node.waitFor(CONNECTED);
  const api = new ServerApi(server.port);
  const sessionId = await sessionWithOneRun(api, dirs);

  // A browser stays connected across the reload: the socket is the process's, not the app's.
  const browser = await api.connect();
  cleanups.push(() => browser.close());
  // SIGUSR2 is the dev reload path a source change triggers, without touching the checkout's files.
  await browser.prompt(sessionId, "slow", "Two [slow:3000]");
  await server.waitFor(WAITING(3000));
  server.proc.kill("SIGUSR2");
  await server.waitFor(/\[hot reload\].*reloaded on SIGUSR2/);
  await node.waitFor(/\[node\] disconnected from server/);
  await node.waitFor(CONNECTED, 2);
  expect(await api.activity(sessionId)).toBe("running");
  expect(await api.transcript(sessionId)).not.toContain("assistant: Echo: Two [slow:3000]");
  await browser.prompt(sessionId, "during", "Three", "steer");

  const transcript = await api.waitForTranscript(sessionId, ["user: Three", "assistant: Echo: Three"], 30_000);
  expect(transcript).toEqual(["user: One", "assistant: Echo: One", "user: Two [slow:3000]", "assistant: Echo: Two [slow:3000]", "user: Three", "assistant: Echo: Three"]);
  await until(async () => await api.activity(sessionId) === "finished", "settled");
  // The request in flight was never asked again, and nothing was suspended or resumed.
  expect(server.count(WAITING(3000))).toBe(1);
  expect(server.output).not.toMatch(/Suspended|resuming it/);
  // The node's link is the app's: the reload dropped it, and the node redialed the new app.
  expect(node.count(CONNECTED)).toBe(2);
  expect(node.count(/\[node\] (?:received|stopped)/)).toBe(0);
  // A clean exit also removes this dev server's own bundle directory.
  const bundle = new URL(`../../.dev-build/${server.proc.pid}`, import.meta.url).pathname;
  expect(existsSync(bundle)).toBe(true);
  expect(await server.stop("SIGTERM")).toBe(0);
  expect(existsSync(bundle)).toBe(false);
  expect(existsSync(dirs.socket)).toBe(false);
}, 90_000);

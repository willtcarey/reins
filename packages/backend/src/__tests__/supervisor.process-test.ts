import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NODE_RESTART } from "../supervisor.js";
import { Child, createProcessLayout, FAUX_PROVIDER, NODE_ENTRY, ServerApi, stopChildren, SUPERVISOR_ENTRY, until, type ProcessLayout } from "./helpers/processes.js";

const cleanups: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  await stopChildren();
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

test("the start supervisor launches server and node, restarts a crashed node with backoff, does not restart it when node code changes, restarts it at once for a reload once its run is paused, and stops both on SIGTERM", async () => {
  const dirs: ProcessLayout = await createProcessLayout();
  cleanups.push(() => dirs.dispose());
  const home = join(dirs.root, "home");
  mkdirSync(home);
  const supervisor = new Child("supervisor", [process.execPath, SUPERVISOR_ENTRY, "start"], {
    cwd: new URL("../../../../", import.meta.url).pathname,
    env: { ...process.env, NODE_ENV: "production", REINS_DEV: "0", REINS_PORT: "0", HOME: home, REINS_DATA_DIR: dirs.dataDir,
      REINS_NODE_SOCKET: dirs.socket, REINS_NODE_TEST_FAUX_PROVIDER: FAUX_PROVIDER },
  });
  const [, port] = await supervisor.waitFor(/listening on http:\/\/localhost:(\d+)/);
  await supervisor.waitFor(/\[node\] connected to server/);
  const api = new ServerApi(Number(port));
  expect(await api.localNodeConnected()).toBe(true);

  // A crashed node is restarted and reconnects.
  const [, pid] = await supervisor.waitFor(/started node \(pid (\d+)\)/);
  process.kill(Number(pid), "SIGKILL");
  await supervisor.waitFor(/node exited with code \d+/);
  await supervisor.waitFor(new RegExp(`node restarting in ${NODE_RESTART.initialMs}ms`));
  await supervisor.waitFor(/started node \(pid (\d+)\)/, 2);
  await supervisor.waitFor(/\[node\] connected to server/, 2);
  await until(() => api.localNodeConnected(), "node reconnected");

  // Node code changes do not restart a running node.
  writeFileSync(NODE_ENTRY, readFileSync(NODE_ENTRY));
  await Bun.sleep(1_500);
  expect(supervisor.count(/started node \(pid/)).toBe(2);

  // A reload waits for the request in flight and holds the run at the tool call it answers with; the node
  // exits and is started again at once, and the server resumes the run there: the call runs once, on the
  // new process, and the run completes.
  const { projectId } = await api.setUp(dirs.repo.dir);
  const sessionId = await api.createSession(projectId);
  const prompt = "Reload [slow:1500] [tool]";
  await api.prompt(sessionId, "slow", prompt);
  await supervisor.waitFor(/\[node\] faux provider waiting for 1500ms/);
  expect(await api.client.nodes.reload("internal")).toEqual({ scheduled: true });
  await supervisor.waitFor(/node reloading/);
  await supervisor.waitFor(/started node \(pid (\d+)\)/, 3);
  await supervisor.waitFor(/\[node\] connected to server/, 3);
  expect(supervisor.count(/node restarting in/)).toBe(1);
  const transcript = await api.waitForTranscript(sessionId, [`assistant: Echo: ${prompt}`]);
  expect(transcript.filter(line => line === `user: ${prompt}`)).toHaveLength(1);
  expect(transcript.filter(line => line === `assistant: Echo: ${prompt}`)).toHaveLength(1);
  await until(async () => await api.activity(sessionId) === "finished", "run settled");
  expect(readFileSync(join(dirs.repo.dir, "tool-runs.log"), "utf8")).toBe("ran\n");
  // One request before the reload, one after the tool call; none repeated.
  expect(supervisor.count(/faux provider waiting for 1500ms/)).toBe(2);

  // SIGTERM stops both children and exits cleanly.
  expect(await supervisor.stop("SIGTERM")).toBe(0);
  await Bun.sleep(100); // drain piped output
  expect(supervisor.output).toContain("received SIGTERM; stopping all services");
  expect(supervisor.output).toContain("[node] stopped");
  expect(supervisor.output).toContain("Received SIGTERM; shutting down");
  expect(existsSync(dirs.socket)).toBe(false);
}, 60_000);

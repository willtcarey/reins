/**
 * Process-level: installing a node with the one-line command. A server process serves its node bundle
 * (with the node's test hooks), and on a "remote machine" (a home of its own) `curl -fsSL
 * <server>/nodes/install | sh -s -- <code>` installs it, pairs it and starts it in the background;
 * `~/.reins/bin/reins node status` and `stop` follow it. The installed node works in a checkout added to a
 * project on it, and updates itself when the server restarts on another build. The node runs on the Bun on
 * its PATH, the one running the tests (ADR-028). See docs/dev/node-bundle.md.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { adoptProcessGroup, Child, createProcessLayout, remoteNodeEnv, ServerApi, startNodeProcess, startServer, stopChildren, until, type ProcessLayout } from "./helpers/processes.js";
import { createTestRepo } from "./helpers/test-repo.js";

const cleanups: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  await stopChildren();
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** A remote machine's environment: Bun, the one running the tests, is on its PATH. */
const remoteMachineEnv = (home: string): Record<string, string | undefined> => ({ ...remoteNodeEnv(home), PATH: `${dirname(process.execPath)}:${process.env.PATH}` });

test("the install command installs, pairs and starts a node that connects; run again it pairs nothing and keeps the node; status and stop follow it", async () => {
  const dirs: ProcessLayout = await createProcessLayout();
  cleanups.push(() => dirs.dispose());
  const server = await startServer(dirs, { REINS_NODE_BUNDLE_TEST_HOOKS: "1" });
  const api = new ServerApi(server.port);
  const serverUrl = `http://localhost:${server.port}`;
  const remoteHome = join(dirs.root, "remote-node-home");
  mkdirSync(remoteHome);
  const env = remoteMachineEnv(remoteHome);
  const nodeHome = env.REINS_NODE_DATA_DIR!;
  const { code } = await api.client.nodes.createPairingCode({ name: "installed" });
  const install = () => new Child("install", ["sh", "-c", `curl -fsSL ${serverUrl}/nodes/install | sh -s -- "$@"`, "sh", code], { cwd: dirs.nodeCwd, env });
  const log = () => readFileSync(join(nodeHome, "logs", "node.log"), "utf8");

  const first = install();
  const firstExit = await first.proc.exited;
  const status = JSON.parse(readFileSync(join(nodeHome, "run", "node-status.json"), "utf8"));
  adoptProcessGroup(status.pid);
  const [node] = (await api.client.nodes.list()).filter(entry => entry.name === "installed");
  expect({ exitCode: firstExit, last: first.output.trimEnd().split("\n").at(-1) }, first.output + log()).toEqual({
    exitCode: 0, last: `Node "installed" (${node!.id}) connected to ${serverUrl} (pid ${status.pid}).`,
  });
  expect(node).toMatchObject({ connected: true, paired: true, sources: [] });
  const { buildId } = z.object({ buildId: z.string() }).parse(await (await fetch(`${serverUrl}/nodes/manifest`)).json());
  expect({ current: readlinkSync(join(nodeHome, "current")), statusBuild: status.buildId }).toEqual({ current: join("builds", buildId), statusBuild: buildId });

  // The code is used: sending it again would be refused. The node keeps running.
  const again = install();
  expect({ exitCode: await again.proc.exited, last: again.output.trimEnd().split("\n").at(-1) }, again.output).toEqual({
    exitCode: 0, last: `Node ${node!.id} connected to ${serverUrl} (pid ${status.pid}).`,
  });
  expect(again.output).toContain("the code was not used");

  const reins = (...args: string[]) => new Child(`reins ${args.join(" ")}`, [join(nodeHome, "bin", "reins"), ...args], { cwd: dirs.nodeCwd, env });
  const nodeStatus = reins("node", "status");
  expect({ exitCode: await nodeStatus.proc.exited, last: nodeStatus.output.trimEnd().split("\n").at(-1) })
    .toEqual({ exitCode: 0, last: `Running (pid ${status.pid}), connected to ${serverUrl} since ${status.since}.` });

  const stop = reins("node", "stop");
  expect({ exitCode: await stop.proc.exited, last: stop.output.trimEnd().split("\n").at(-1) }).toEqual({ exitCode: 0, last: `Node stopped (pid ${status.pid}).` });
  await until(async () => !(await api.client.nodes.list()).find(entry => entry.id === node!.id)?.connected, "the node disconnected");
  expect(log().trimEnd().split("\n").at(-1)).toBe("[node] stopped");
  expect(server.output + first.output + again.output + log()).not.toContain(code);
}, 90_000);

test("an installed node works in a checkout added to a project on it, and when the server restarts on another build it downloads it, restarts on it through its launcher and reconnects announcing it", async () => {
  const dirs: ProcessLayout = await createProcessLayout();
  cleanups.push(() => dirs.dispose());
  const server = await startServer(dirs, { REINS_NODE_BUNDLE_TEST_HOOKS: "1" });
  const api = new ServerApi(server.port);
  const serverUrl = `http://localhost:${server.port}`;
  const remoteHome = join(dirs.root, "remote-node-home");
  mkdirSync(remoteHome);
  const env = remoteMachineEnv(remoteHome);
  const nodeHome = env.REINS_NODE_DATA_DIR!;
  const repo = await createTestRepo();
  cleanups.push(() => repo.cleanup());
  const checkout = realpathSync(repo.dir);
  const manifest = async () => z.object({ buildId: z.string() }).parse(await (await fetch(`${serverUrl}/nodes/manifest`)).json());
  const { buildId: firstBuild } = await manifest();

  const { code } = await api.client.nodes.createPairingCode({ name: "remote" });
  const install = new Child("install", ["sh", "-c", `curl -fsSL ${serverUrl}/nodes/install | sh -s -- "$@"`, "sh", code], { cwd: dirs.nodeCwd, env });
  const log = () => readFileSync(join(nodeHome, "logs", "node.log"), "utf8");
  expect(await install.proc.exited, install.output).toBe(0);
  adoptProcessGroup(JSON.parse(readFileSync(join(nodeHome, "run", "node-status.json"), "utf8")).pid);
  const remote = (await api.client.nodes.list()).find(entry => entry.name === "remote")!;
  expect(remote).toMatchObject({ connected: true, sources: [], build: { id: firstBuild, status: "current" } });

  // A project on the local node, to which a checkout on the remote node is added (POST
  // /api/projects/:id/sources); a session moved to the remote node runs a turn with a bash call there.
  startNodeProcess(dirs);
  await until(() => api.localNodeConnected(), "the local node connected");
  const { projectId } = await api.setUp(dirs.repo.dir);
  await api.client.projects.addSource(projectId, { nodeId: remote.id, path: checkout });
  const sessionId = await api.createSession(projectId);
  await api.client.sessions.move(sessionId, { nodeId: remote.id });
  await api.prompt(sessionId, "turn", "Run it [tool]");
  await api.waitForTranscript(sessionId, ["user: Run it [tool]", "assistant: ", "assistant: Echo: Run it [tool]"]);
  await until(async () => await api.activity(sessionId) === "finished", "the turn settled");
  expect(readFileSync(join(checkout, "tool-runs.log"), "utf8")).toBe("ran\n");

  // The server restarts on another build (without the test hooks), on the same port and data.
  expect(await server.stop("SIGTERM")).toBe(0);
  const restarted = await startServer(dirs, { REINS_PORT: String(server.port) });
  const { buildId: nextBuild } = await manifest();
  expect(nextBuild).not.toBe(firstBuild);
  await until(async () => (await api.client.nodes.list()).find(entry => entry.id === remote.id)?.build?.id === nextBuild, "the node reconnected on the new build", 60_000)
    .catch((error: unknown) => { throw new Error(`${String(error)}\n${restarted.output}\n${log()}`); });

  expect((await api.client.nodes.list()).find(entry => entry.id === remote.id)).toMatchObject({ connected: true, build: { id: nextBuild, status: "current" } });
  expect(readlinkSync(join(nodeHome, "current"))).toBe(join("builds", nextBuild));
  expect(log()).toContain(`[node] the server runs build ${nextBuild.slice(0, 12)}; updating to it`);
  expect(restarted.output).toContain(`Node ${remote.id} runs build ${firstBuild.slice(0, 12)}; telling it to update to ${nextBuild.slice(0, 12)}`);
  const status = new Child("reins node status", [join(nodeHome, "bin", "reins"), "node", "status"], { cwd: dirs.nodeCwd, env });
  expect({ exitCode: await status.proc.exited, build: status.output.split("\n").find(line => line.startsWith("Build:")), last: status.output.trimEnd().split("\n").at(-1) })
    .toEqual({ exitCode: 0, build: `Build: ${nextBuild}`, last: expect.stringMatching(/^Running \(pid \d+\), connected to /) });
  expect(server.output + restarted.output + install.output + log()).not.toContain(code);
}, 120_000);

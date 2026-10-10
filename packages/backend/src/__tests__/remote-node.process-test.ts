/**
 * Process-level: a remote node. A server process, and a node paired with it and run by `reins node run`
 * from this checkout, meeting only on the server's `/node-link` WebSocket. See node-transport.md *The
 * WebSocket link* and node-contract.md *Process model* and *Node hub* (nodes and sources).
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { ReinsHttpError } from "@reins/client";
import { Child, CLI_ENTRY, createProcessLayout, FAUX_PROVIDER, ServerApi, startNodeProcess, startServer, stopChildren, until, type ProcessLayout } from "./helpers/processes.js";

const cleanups: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  await stopChildren();
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

test("a node paired with a code from the API and run with `reins node run` connects over the WebSocket and reports the checkout it declares; attached to a project, a session there completes a turn with a bash call, and an undeclared path is refused", async () => {
  const dirs: ProcessLayout = await createProcessLayout();
  cleanups.push(() => dirs.dispose());
  const server = await startServer(dirs);
  // The local node holds the project's first checkout; the remote node gets a second one.
  startNodeProcess(dirs);
  const api = new ServerApi(server.port);
  await until(() => api.localNodeConnected(), "the local node connected");
  const serverUrl = `http://localhost:${server.port}`;
  const remoteHome = join(dirs.root, "remote-node-home");
  mkdirSync(remoteHome);
  const nodeEnv = {
    ...process.env, NODE_ENV: "production", HOME: remoteHome, REINS_NODE_DATA_DIR: join(remoteHome, ".reins"),
    REINS_NODE_SOCKET: undefined, REINS_NODE_TEST_FAUX_PROVIDER: FAUX_PROVIDER,
  };
  const checkout = realpathSync(dirs.repo.dir);

  // The code goes from the API to the CLI's arguments only; neither prints it.
  const { code } = await api.client.nodes.createPairingCode({ name: "remote" });
  const pair = new Child("pair", [process.execPath, CLI_ENTRY, "node", "pair", serverUrl, code], { cwd: dirs.nodeCwd, env: nodeEnv });
  expect(await pair.proc.exited).toBe(0);
  const [, nodeId] = await pair.waitFor(/as node "remote" \(([\w-]+)\)/);
  const declare = new Child("source add", [process.execPath, CLI_ENTRY, "node", "source", "add", dirs.repo.dir], { cwd: dirs.nodeCwd, env: nodeEnv });
  expect(await declare.proc.exited).toBe(0);

  const node = new Child("node run", [process.execPath, CLI_ENTRY, "node", "run"], { cwd: dirs.nodeCwd, env: nodeEnv });
  await node.waitFor(/\[node\] connected to server at ws:\/\/localhost:\d+\/node-link/);
  await server.waitFor(new RegExp(`Node ${nodeId} connected`));
  expect((await api.client.nodes.list()).find(entry => entry.id === nodeId)).toMatchObject({
    connected: true, paired: true, sources: [{ path: checkout, project: null, undeclared: false }],
  });

  // A checkout the node does not declare is refused, by the node.
  const refused = await api.client.projects.create({ name: "elsewhere", path: dirs.nodeCwd, nodeId: nodeId! }).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(ReinsHttpError);
  expect(refused).toMatchObject({ status: 400, message: `Not a source of this node: ${dirs.nodeCwd}` });

  const { projectId } = await api.setUp(dirs.nodeCwd);
  await api.client.projects.addSource(projectId, { nodeId: nodeId!, path: checkout });
  expect((await api.client.nodes.list()).find(entry => entry.id === nodeId)?.sources).toEqual([
    { path: checkout, project: { id: projectId, name: "processes", sourceId: expect.any(Number) }, undeclared: false },
  ]);
  const sessionId = await api.createSession(projectId);
  await api.client.sessions.move(sessionId, { nodeId: nodeId! });
  // The faux provider answers `[tool]` with a bash call appending to tool-runs.log in the checkout.
  await api.prompt(sessionId, "first", "Run it [tool]");
  // The bash call is an assistant message without text.
  await api.waitForTranscript(sessionId, ["user: Run it [tool]", "assistant: ", "assistant: Echo: Run it [tool]"]);
  await until(async () => await api.activity(sessionId) === "finished", "settled");
  expect(readFileSync(join(dirs.repo.dir, "tool-runs.log"), "utf8")).toBe("ran\n");

  expect(await node.stop("SIGTERM")).toBe(0);
  expect(node.output.trimEnd().split("\n").at(-1)).toBe("[node] stopped");
  expect(server.output + node.output + pair.output).not.toContain(code);
}, 60_000);

/**
 * Process-level: a remote node. A server process, and a node paired with it and run by `reins node run`
 * from this checkout, meeting only on the server's `/nodes/link` WebSocket. See node-transport.md *The
 * WebSocket link* and node-contract.md *Process model*, *Checkout operations* and *Node hub* (nodes and
 * sources).
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { ReinsHttpError } from "@reins/client";
import { Child, CLI_ENTRY, createProcessLayout, pairRemoteNode, remoteNodeEnv, ServerApi, startServer, stopChildren, until, type ProcessLayout } from "./helpers/processes.js";

const cleanups: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  await stopChildren();
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

test("a node paired with a code from the API and run with `reins node run` connects over the WebSocket; a project created on it works in the path the server sends, and a session there completes a turn with a bash call", async () => {
  const dirs: ProcessLayout = await createProcessLayout();
  cleanups.push(() => dirs.dispose());
  const server = await startServer(dirs);
  const api = new ServerApi(server.port);
  const serverUrl = `http://localhost:${server.port}`;
  const remoteHome = join(dirs.root, "remote-node-home");
  mkdirSync(remoteHome);
  const nodeEnv = remoteNodeEnv(remoteHome);
  const checkout = realpathSync(dirs.repo.dir);

  // The code goes from the API to the CLI's arguments only; neither prints it.
  const pairing = await pairRemoteNode(api, { reins: [process.execPath, CLI_ENTRY], serverUrl, name: "remote", cwd: dirs.nodeCwd, env: nodeEnv });
  const { nodeId, code } = pairing;

  const node = new Child("node run", [process.execPath, CLI_ENTRY, "node", "run"], { cwd: dirs.nodeCwd, env: nodeEnv });
  await node.waitFor(/\[node\] connected to server at ws:\/\/localhost:\d+\/nodes\/link/);
  await server.waitFor(new RegExp(`Node ${nodeId} connected`));
  expect((await api.client.nodes.list()).find(entry => entry.id === nodeId)).toMatchObject({ connected: true, paired: true, sources: [] });

  // A path that is not a directory on the node is refused: the node looked.
  const missing = join(dirs.root, "missing");
  const refused = await api.client.projects.create({ name: "elsewhere", path: missing, nodeId }).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(ReinsHttpError);
  expect(refused).toMatchObject({ status: 400, message: `Directory does not exist: ${missing}` });

  const { projectId } = await api.setUp(checkout, nodeId);
  expect((await api.client.nodes.list()).find(entry => entry.id === nodeId)?.sources).toEqual([
    { path: checkout, project: { id: projectId, name: "processes", sourceId: expect.any(Number) } },
  ]);
  const sessionId = await api.createSession(projectId);
  // The faux provider answers `[tool]` with a bash call appending to tool-runs.log in the checkout.
  await api.prompt(sessionId, "first", "Run it [tool]");
  // The bash call is an assistant message without text.
  await api.waitForTranscript(sessionId, ["user: Run it [tool]", "assistant: ", "assistant: Echo: Run it [tool]"]);
  await until(async () => await api.activity(sessionId) === "finished", "settled");
  expect(readFileSync(join(dirs.repo.dir, "tool-runs.log"), "utf8")).toBe("ran\n");

  expect(await node.stop("SIGTERM")).toBe(0);
  expect(node.output.trimEnd().split("\n").at(-1)).toBe("[node] stopped");
  expect(server.output + node.output + pairing.output).not.toContain(code);
}, 60_000);

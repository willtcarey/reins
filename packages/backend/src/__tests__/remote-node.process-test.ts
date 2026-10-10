/**
 * Process-level: a remote node. A server process, and a node paired with it and run by `reins node run`
 * from this checkout, meeting only on the server's `/node-link` WebSocket. See node-transport.md *The
 * WebSocket link* and node-contract.md *Process model*.
 */
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Child, CLI_ENTRY, createProcessLayout, FAUX_PROVIDER, ServerApi, startServer, stopChildren, until, type ProcessLayout } from "./helpers/processes.js";

const cleanups: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  await stopChildren();
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

test("a node paired with a code from the API and run with `reins node run` connects over the WebSocket, and a session on its checkout completes a turn with a bash call", async () => {
  const dirs: ProcessLayout = await createProcessLayout();
  cleanups.push(() => dirs.dispose());
  // No local node: the only node is the remote one.
  const server = await startServer(dirs);
  const api = new ServerApi(server.port);
  const serverUrl = `http://localhost:${server.port}`;
  const nodeEnv = {
    ...process.env, NODE_ENV: "production", HOME: dirs.nodeHome, REINS_NODE_DATA_DIR: join(dirs.nodeHome, ".reins"),
    REINS_NODE_SOCKET: undefined, REINS_NODE_TEST_FAUX_PROVIDER: FAUX_PROVIDER,
  };

  // The code goes from the API to the CLI's arguments only; neither prints it.
  const { code } = await api.client.nodes.createPairingCode({ name: "remote" });
  const pair = new Child("pair", [process.execPath, CLI_ENTRY, "node", "pair", serverUrl, code], { cwd: dirs.nodeCwd, env: nodeEnv });
  expect(await pair.proc.exited).toBe(0);
  const [, nodeId] = await pair.waitFor(/as node "remote" \(([\w-]+)\)/);

  const node = new Child("node run", [process.execPath, CLI_ENTRY, "node", "run"], { cwd: dirs.nodeCwd, env: nodeEnv });
  await node.waitFor(/\[node\] connected to server at ws:\/\/localhost:\d+\/node-link/);
  await server.waitFor(new RegExp(`Node ${nodeId} connected`));
  expect((await api.client.nodes.list()).find(entry => entry.id === nodeId)).toMatchObject({ connected: true, paired: true });

  await api.client.auth.putApiKey(FAUX_PROVIDER, "test-key");
  await api.client.settings.put("default_model", { provider: FAUX_PROVIDER, modelId: "fake", runtimeType: "pi", thinkingLevel: "minimal" });
  const project = await api.client.projects.create({ name: "remote", path: dirs.repo.dir, nodeId: nodeId! });
  const sessionId = await api.createSession(project.id);
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

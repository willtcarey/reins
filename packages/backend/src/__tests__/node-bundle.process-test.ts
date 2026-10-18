/**
 * Process-level: the node bundle. `reins.js`, built by `buildNodeBundle` into a directory outside the
 * repository with no `node_modules`, pairs and runs a remote node there under `bun
 * --no-install`, against a server process from this checkout, over the WebSocket. See
 * docs/dev/node-bundle.md.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildNodeBundle } from "../node-bundle/build.js";
import { Child, createProcessLayout, pairRemoteNode, remoteNodeEnv, ServerApi, startServer, stopChildren, until, type ProcessLayout } from "./helpers/processes.js";

const REPO_ROOT = new URL("../../../../", import.meta.url).pathname;

const cleanups: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  await stopChildren();
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

test("a bundle run outside the repository pairs and runs a node that completes a turn with a bash call, its sessions told of the docs it wrote beside itself", async () => {
  const dirs: ProcessLayout = await createProcessLayout();
  cleanups.push(() => dirs.dispose());
  const buildDir = realpathSync(mkdtempSync(join(tmpdir(), "reins-bundle-")));
  cleanups.push(() => rmSync(buildDir, { recursive: true, force: true }));
  const bundle = join(buildDir, "reins.js");
  writeFileSync(bundle, (await buildNodeBundle()).bytes);

  // The server's own build is the same bytes (the build is deterministic), so the node is not told to update.
  const server = await startServer(dirs);
  const api = new ServerApi(server.port);
  const remoteHome = join(dirs.root, "remote-node-home");
  mkdirSync(remoteHome);
  const nodeEnv = remoteNodeEnv(remoteHome);
  const reins = [process.execPath, "--no-install", bundle];
  const checkout = realpathSync(dirs.repo.dir);

  const { nodeId, code, output } = await pairRemoteNode(api, { reins, serverUrl: `http://localhost:${server.port}`, name: "bundled", cwd: dirs.nodeCwd, env: nodeEnv });
  const node = new Child("node run", [...reins, "node", "run"], { cwd: dirs.nodeCwd, env: nodeEnv });
  await node.waitFor(/\[node\] connected to server at ws:\/\/localhost:\d+\/nodes\/link/);
  await until(async () => (await api.client.nodes.list()).some(entry => entry.id === nodeId && entry.connected), "the bundled node connected");

  const { projectId } = await api.setUp(checkout, nodeId);
  const sessionId = await api.createSession(projectId);
  // The faux provider answers `[tool]` with a bash call appending to tool-runs.log in the checkout, and
  // `[docs]` with the system prompt's feature docs line.
  await api.prompt(sessionId, "first", "Run it [tool] [docs]");
  await api.waitForTranscript(sessionId, ["user: Run it [tool] [docs]", "assistant: ", `assistant: - Feature docs: ${join(buildDir, "docs/features")}`]);
  await until(async () => await api.activity(sessionId) === "finished", "settled");
  expect(readFileSync(join(checkout, "tool-runs.log"), "utf8")).toBe("ran\n");

  // The docs beside the bundle are docs/features as built.
  const shipped = readdirSync(join(REPO_ROOT, "docs/features")).toSorted();
  expect(readdirSync(join(buildDir, "docs/features")).toSorted()).toEqual(shipped);
  expect(readFileSync(join(buildDir, "docs/features", shipped[0]!), "utf8")).toBe(readFileSync(join(REPO_ROOT, "docs/features", shipped[0]!), "utf8"));
  expect(readdirSync(buildDir).toSorted()).toEqual(["docs", "reins.js"]);

  expect(await node.stop("SIGTERM")).toBe(0);
  expect(node.output.trimEnd().split("\n").at(-1)).toBe("[node] stopped");
  expect(server.output + node.output + output).not.toContain(code);
}, 60_000);

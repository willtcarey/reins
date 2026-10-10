/**
 * Process-level: installing a node with the one-line command. A server process serves its node bundle
 * (with the node's test hooks), and on a "remote machine" (a home of its own) `curl -fsSL
 * <server>/nodes/install | sh -s -- <code> --source <checkout>` installs it, pairs it and starts it in the
 * background; `~/.reins/bin/reins node status` and `stop` follow it. Bun is pre-seeded in the node home,
 * so nothing is downloaded but the bundle. See docs/dev/node-bundle.md.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { adoptProcessGroup, Child, createProcessLayout, remoteNodeEnv, ServerApi, startServer, stopChildren, until, type ProcessLayout } from "./helpers/processes.js";

const cleanups: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  await stopChildren();
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

test("the install command installs, pairs and starts a node that connects and reports its checkout; run again it pairs nothing and keeps the node; status and stop follow it", async () => {
  const dirs: ProcessLayout = await createProcessLayout();
  cleanups.push(() => dirs.dispose());
  const server = await startServer(dirs, { REINS_NODE_BUNDLE_TEST_HOOKS: "1" });
  const api = new ServerApi(server.port);
  const serverUrl = `http://localhost:${server.port}`;
  const remoteHome = join(dirs.root, "remote-node-home");
  mkdirSync(remoteHome);
  const env = remoteNodeEnv(remoteHome);
  const nodeHome = env.REINS_NODE_DATA_DIR!;
  mkdirSync(nodeHome, { mode: 0o700 });
  symlinkSync(process.execPath, join(nodeHome, "bun"));
  const checkout = realpathSync(dirs.repo.dir);
  const { code } = await api.client.nodes.createPairingCode({ name: "installed" });
  const install = () => new Child("install", ["sh", "-c", `curl -fsSL ${serverUrl}/nodes/install | sh -s -- "$@"`, "sh", code, "--source", checkout], { cwd: dirs.nodeCwd, env });
  const log = () => readFileSync(join(nodeHome, "logs", "node.log"), "utf8");

  const first = install();
  const firstExit = await first.proc.exited;
  const status = JSON.parse(readFileSync(join(nodeHome, "run", "node-status.json"), "utf8"));
  adoptProcessGroup(status.pid);
  const [node] = (await api.client.nodes.list()).filter(entry => entry.name === "installed");
  expect({ exitCode: firstExit, last: first.output.trimEnd().split("\n").at(-1) }, first.output + log()).toEqual({
    exitCode: 0, last: `Node "installed" (${node!.id}) connected to ${serverUrl} (pid ${status.pid}).`,
  });
  expect(node).toMatchObject({ connected: true, paired: true, sources: [{ path: checkout, project: null, undeclared: false }] });
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

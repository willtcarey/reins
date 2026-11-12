import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { startNode, type Node, type NodeOptions } from "@reins/node/node";
import type { NodeProcess, ServerSdk } from "@reins/sdk/server";
import { useTestDb } from "../helpers/test-db.js";
import { createAppState, type TestAppState } from "../helpers/app-state.js";
import { dialLoopback, type LoopbackLink } from "../helpers/loopback-node.js";
import { getDb } from "../../app-globals.js";
import type { BuiltInBackendPart } from "../../extension-system/extensions.js";
import { NodeProcess as ServerNodeProcess } from "../../nodes/node-process.js";

setDefaultTimeout(20_000);

const until = async (condition: () => boolean) => { for (let i = 0; i < 400 && !condition(); i++) await Bun.sleep(5); expect(condition()).toBe(true); };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const recorded = () => getDb().query("SELECT owner, node_id, key FROM processes ORDER BY key").all();

/** The lines a process prints, as they come. */
function reading(proc: NodeProcess) {
  const lines: string[] = [];
  const done = (async () => { for await (const line of proc.lines) lines.push(line); })().then(() => null, (error: Error) => error);
  return { lines, done };
}

const tunnel = (token: string) => ({ key: "tunnel", ifRunning: "attach" as const, env: { TOKEN: token } });

describe("processes the host keeps for an extension under a key", () => {
  useTestDb();
  let current: TestAppState;
  let reins: ServerSdk;
  let node: Node;
  let link: LoopbackLink;
  const apps: TestAppState[] = [];
  const keeper: BuiltInBackendPart = { name: "keeper", register: sdk => { reins = sdk; return () => {}; } };
  const startApp = (extensions = [keeper]) => {
    current = createAppState(undefined, { extensions, builtInNames: extensions.map(({ name }) => name) });
    apps.push(current);
  };
  /** The node, linked to whichever app is current. */
  const startLinkedNode = async (options: NodeOptions = {}) => {
    node = startNode(options);
    link = dialLoopback(current, node, { nodeId: "mini", hub: () => current.nodes });
    await link.ready();
  };
  /** An app's stop as `server.ts` does it, the next app started meanwhile: the node redials it. */
  const reload = async (extensions = [keeper]) => {
    const old = current;
    await old.processes.release();
    startApp(extensions);
    await Promise.all([old.nodes.close(), old.extensions.dispose()]);
    await link.ready();
    await current.extensions.loaded;
  };

  beforeEach(async () => {
    getDb().exec("INSERT INTO nodes (id, name) VALUES ('mini', 'Mac mini')");
    startApp();
    await startLinkedNode();
  });
  afterEach(async () => {
    for (const app of apps) await app.extensions.dispose();
    link.stop();
    await node.shutdown();
    for (const app of apps.splice(0)) await app.nodes.close();
  });

  test("by default a spawn under a key replaces the process kept there, once it has ended", async () => {
    const first = await reins.nodes.spawn("mini", ["sleep", "100"], { key: "dev:app" });
    const second = await reins.nodes.spawn("mini", ["sleep", "100"], { key: "dev:app" });

    expect(await first.exited).toEqual({ code: null, signal: "SIGTERM" });
    expect(alive(first.pid)).toBe(false);
    expect(second).toMatchObject({ key: "dev:app", reattached: false });
    expect(second.pid).not.toBe(first.pid);
    expect(await reins.nodes.processes()).toEqual([{ key: "dev:app", nodeId: "mini", pid: second.pid, state: "running", startedAt: expect.any(String) }]);
  });

  test("an attach in the app that started the process gets the handle it has: one per process", async () => {
    const [a, b] = await Promise.all([1, 2].map(() => reins.nodes.spawn("mini", ["sleep", "100"], { key: "shared", ifRunning: "attach" })));
    const later = await reins.nodes.spawn("mini", ["sleep", "100"], { key: "shared", ifRunning: "attach" });

    expect(b).toBe(a!);
    expect(later).toBe(a!);
    expect(a!.reattached).toBe(false);
  });

  test("attach replaces a process started with another command or environment; neither is kept, only a keyed hash", async () => {
    const first = await reins.nodes.spawn("mini", ["sleep", "100"], tunnel("s3cret-one"));
    const same = await reins.nodes.spawn("mini", ["sleep", "100"], tunnel("s3cret-one"));
    const otherEnv = await reins.nodes.spawn("mini", ["sleep", "100"], tunnel("s3cret-two"));
    const otherCommand = await reins.nodes.spawn("mini", ["sleep", "200"], tunnel("s3cret-two"));

    expect(same).toBe(first);
    expect(otherEnv.reattached).toBe(false);
    expect(await first.exited).toEqual({ code: null, signal: "SIGTERM" });
    expect(otherCommand.reattached).toBe(false);
    expect(await otherEnv.exited).toEqual({ code: null, signal: "SIGTERM" });
    expect(JSON.stringify(getDb().query("SELECT * FROM processes").all())).not.toMatch(/s3cret|sleep/);
  });

  test("a reload stops a process without a key, and lets go of a keyed one, which the next app attaches to and reads on from where the last one was", async () => {
    const keyless = await reins.nodes.spawn("mini", ["sleep", "100"]);
    const kept = await reins.nodes.spawn("mini", ["sh", "-c", "while read line; do sleep 0.2; echo \"got $line\"; done"], { key: "mcp:echo", ifRunning: "attach" });
    const before = reading(kept);
    await kept.write("1\n");
    await until(() => before.lines.length === 1);
    // Answered during the reload: read by the next app.
    await kept.write("2\n");

    await reload();

    expect(await keyless.exited).toEqual({ code: null, signal: "SIGTERM" });
    expect(await kept.exited).toEqual({ code: null, signal: null, detached: true });
    expect(alive(kept.pid)).toBe(true);
    expect(await reins.nodes.processes()).toEqual([{ key: "mcp:echo", nodeId: "mini", pid: kept.pid, state: "detached", startedAt: expect.any(String) }]);
    const again = await reins.nodes.spawn("mini", ["sh", "-c", "while read line; do sleep 0.2; echo \"got $line\"; done"], { key: "mcp:echo", ifRunning: "attach" });
    const after = reading(again);
    await again.write("3\n");
    await until(() => after.lines.length === 2);

    expect(again).toMatchObject({ pid: kept.pid, reattached: true, lostBytes: 0 });
    expect([...before.lines, ...after.lines]).toEqual(["got 1", "got 2", "got 3"]);
  });

  test("output its node no longer kept when the next app attaches is counted as lost", async () => {
    link.stop();
    await node.shutdown();
    await startLinkedNode({ processTailBytes: 1024 });
    const command = ["sh", "-c", "read go; for i in 1 2 3 4 5 6; do head -c 400 /dev/zero | tr '\\0' x; echo; done; sleep 100"];
    const kept = await reins.nodes.spawn("mini", command, { key: "noisy", ifRunning: "attach" });
    reading(kept);
    await kept.write("go\n");

    await reload();
    await Bun.sleep(200);
    const again = await reins.nodes.spawn("mini", command, { key: "noisy", ifRunning: "attach" });

    expect(again.reattached).toBe(true);
    expect(again.lostBytes).toBeGreaterThan(0);
  });

  test("a process let go in a running app (its extension reloaded) runs on for its node's grace period, then its node stops it", async () => {
    link.stop();
    await node.shutdown();
    await startLinkedNode({ processGraceMs: 300 });
    const kept = await reins.nodes.spawn("mini", ["sleep", "100"], { key: "lsp:src" });

    // What the host does to it when its extension unloads in a running app.
    if (!(kept instanceof ServerNodeProcess)) throw new Error("Not the server's handle");
    kept.detach();
    await Bun.sleep(100);
    expect(alive(kept.pid)).toBe(true);

    await until(() => !alive(kept.pid));
  });

  test("turning the extension off stops its kept processes and forgets them", async () => {
    const kept = await reins.nodes.spawn("mini", ["sleep", "100"], { key: "lsp:src" });

    await current.extensions.setEnabled("keeper", false);

    expect(alive(kept.pid)).toBe(false);
    expect(recorded()).toEqual([]);
  });

  test("after a reload in which the extension's code does not load, its kept processes are stopped", async () => {
    const kept = await reins.nodes.spawn("mini", ["sleep", "100"], { key: "lsp:src" });

    await reload([]);

    await until(() => !alive(kept.pid));
    expect(recorded()).toEqual([]);
  });

  test("processes lists the kept processes and how they ended; stop stops one without a handle and forgets its key", async () => {
    const running = await reins.nodes.spawn("mini", ["sleep", "100"], { key: "a" });
    const ended = await reins.nodes.spawn("mini", ["sh", "-c", "exit 3"], { key: "b" });
    await ended.exited;
    await reins.nodes.spawn("mini", ["sleep", "100"], { key: "c" });

    expect(await reins.nodes.processes()).toEqual([
      { key: "a", nodeId: "mini", pid: running.pid, state: "running", startedAt: expect.any(String) },
      { key: "b", nodeId: "mini", pid: ended.pid, state: "ended", exit: { code: 3, signal: null }, startedAt: expect.any(String) },
      { key: "c", nodeId: "mini", pid: expect.any(Number), state: "running", startedAt: expect.any(String) },
    ]);
    expect(await reins.nodes.stop("Mac mini", "a")).toEqual({ code: null, signal: "SIGTERM" });
    expect(await reins.nodes.stop("mini", "a")).toBeNull();
    await reload();
    expect(await reins.nodes.stop("mini", "c")).toEqual({ code: null, signal: "SIGTERM" });
    expect(await reins.nodes.stop("mini", "b")).toEqual({ code: 3, signal: null });
    expect(recorded()).toEqual([]);
  });

  test("a spawn that finds its key's process gone says how it ended: its exit, or lost with its node", async () => {
    const job = await reins.nodes.spawn("mini", ["sh", "-c", "exit 3"], { key: "job", ifRunning: "attach" });
    await job.exited;
    const next = await reins.nodes.spawn("mini", ["sleep", "100"], { key: "job", ifRunning: "attach" });
    expect(next).toMatchObject({ reattached: false, previous: { code: 3, signal: null } });

    await reload();
    link.stop();
    await node.shutdown();
    await startLinkedNode();
    const after = await reins.nodes.spawn("mini", ["sleep", "100"], { key: "job", ifRunning: "attach" });

    expect(after).toMatchObject({ reattached: false, previous: { code: null, signal: null, error: expect.stringContaining("The process is gone") } });
  });

  test("refuses a key out of bounds and ifRunning without a key", async () => {
    await expect(reins.nodes.spawn("mini", "true", { key: "" })).rejects.toThrow("A process's key is a string of 1 to 256 characters");
    await expect(reins.nodes.spawn("mini", "true", { ifRunning: "attach" })).rejects.toThrow("ifRunning says what to do with a process kept under a key: give a key");
  });
});

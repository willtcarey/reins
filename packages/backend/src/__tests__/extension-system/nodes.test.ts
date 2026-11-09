import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ServerSdk } from "@reins/sdk/server";
import { useTestDb } from "../helpers/test-db.js";
import { createAppState, type TestAppState } from "../helpers/app-state.js";
import { connectLoopbackNode, loopbackLink, stopLoopbackNode } from "../helpers/loopback-node.js";
import { getDb } from "../../app-globals.js";

describe("reins.nodes", () => {
  useTestDb();
  let state: TestAppState;
  let reins: ServerSdk;
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "reins-extension-nodes-"));
    getDb().exec("INSERT INTO nodes (id, name) VALUES ('mini', 'Mac mini'), ('away', 'Away')");
    state = createAppState(undefined, { extensions: [{ name: "checks", register: sdk => { reins = sdk; return () => {}; } }] });
    connectLoopbackNode(state, { nodeId: "mini" });
    await loopbackLink(state, "mini").ready();
  });
  afterEach(async () => {
    await stopLoopbackNode(state, "mini");
    await state.nodes.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("runs a command on a node named by its ID or its name, in a directory, and gives its exit code and output", async () => {
    expect(await reins.nodes.run("mini", "echo out; echo err >&2; exit 3")).toEqual({ exitCode: 3, output: "out\nerr\n", truncated: false });
    expect(await reins.nodes.run("mac MINI", "pwd", { cwd: dir })).toEqual({ exitCode: 0, output: `${dir}\n`, truncated: false });
  });

  test("gives a command the environment variables it is given, added to the node's own", async () => {
    const result = await reins.nodes.run("mini", `printf '%s|%s' "$API_KEY" "\${HOME:+home}"`, { env: { API_KEY: "it's $ecret \"quoted\"" } });

    expect(result).toEqual({ exitCode: 0, output: "it's $ecret \"quoted\"|home", truncated: false });
  });

  test("the extension's signal stops the command", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const running = reins.nodes.run("mini", "sleep 5", { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);

    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("refuses a blank command, a timeout out of range, and a node that is unknown or not connected", async () => {
    await expect(reins.nodes.run("mini", "  ")).rejects.toThrow("A command must not be blank");
    await expect(reins.nodes.run("mini", "true", { timeoutMs: 0 })).rejects.toThrow("timeoutMs must be from 1 to 600000");
    await expect(reins.nodes.run("mini", "true", { timeoutMs: 600_001 })).rejects.toThrow("timeoutMs must be from 1 to 600000");
    await expect(reins.nodes.run("away", "true")).rejects.toThrow('Node unavailable: "Away" (away) is not connected');
    await expect(reins.nodes.run("nowhere", "true")).rejects.toThrow("Node not found: nowhere");
  });

  test("reads, writes and copies files on a node and lists the nodes, as scripts do; it names the node, as it has no \"current\"", async () => {
    await reins.nodes.writeFile("mini", join(dir, "notes/plan.md"), "# Plan\n");
    const copied = await reins.nodes.copy("Mac mini", join(dir, "notes/plan.md"), "mini", join(dir, "copy/plan.md"));

    expect(await reins.nodes.readFile("mini", join(dir, "copy/plan.md"))).toBe("# Plan\n");
    expect(copied).toEqual({ bytes: 7 });
    expect((await reins.nodes.list()).map(({ id, connected, current }) => ({ id, connected, current }))).toEqual([
      { id: "away", connected: false, current: false },
      { id: "internal", connected: false, current: false },
      { id: "mini", connected: true, current: false },
    ]);
    await expect(reins.nodes.get()).rejects.toThrow("\"current\" names the calling session's node, and an extension has none: name the node");
  });
});

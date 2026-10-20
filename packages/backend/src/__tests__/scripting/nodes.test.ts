import { describe, test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { NodeRejection } from "@reins/node-protocol";
import { runScript } from "../../tools/execute.js";
import { getDb } from "../../app-globals.js";
import { createSource, defaultSource } from "../../node-store.js";
import { nodesGetFunction, nodesListFunction, nodesReloadFunction } from "../../scripting/nodes.js";
import type { ApiContext } from "../../scripting/define-function.js";
import { Models } from "../../models/models.js";
import { createProject } from "../project-fixture.js";
import { createAppState } from "../helpers/app-state.js";
import { useTestDb } from "../helpers/test-db.js";
import { connectLoopbackNode, connectScriptedNode, loopbackLink, SEEDED_NODE_ID, stopLoopbackNode } from "../helpers/loopback-node.js";

describe("nodes.list and nodes.get", () => {
  useTestDb();

  test("lists every node not removed, whether it is connected and the caller's, and how many sources it holds; get lists a node's sources", async () => {
    const state = createAppState();
    const project = createProject("Listed", "/tmp/list-local");
    getDb().exec(`INSERT INTO nodes (id, name, hostname, revoked_at) VALUES ('box', 'Box', 'box.lan', NULL), ('gone', 'Gone', NULL, NULL), ('old', 'Old', NULL, '2026-10-01T00:00:00Z');
      UPDATE nodes SET removed_at = '2026-10-02T00:00:00Z' WHERE id = 'gone'`);
    const boxSource = createSource(project.id, "box", "/srv/work").id;
    const box = connectScriptedNode(state, "box", {});
    const ctx: ApiContext = { projectId: project.id, sessionId: "caller", taskId: null, broadcast: () => {}, sourceId: boxSource, nodes: state.nodes, models: new Models(state) };
    try {
      await box.ready();
      const boxView = { id: "box", name: "Box", hostname: "box.lan", connected: true, revoked: false, current: true, sourceCount: 1 };
      const localView = { id: SEEDED_NODE_ID, name: "Internal", hostname: null, connected: false, revoked: false, current: false, sourceCount: 1 };
      expect(nodesListFunction.execute({}, ctx)).toEqual([
        boxView,
        localView,
        { id: "old", name: "Old", hostname: null, connected: false, revoked: true, current: false, sourceCount: 0 },
      ]);
      expect(nodesGetFunction.execute({}, ctx)).toEqual({ ...boxView, sources: [{ sourceId: boxSource, projectId: project.id, projectName: "Listed", path: "/srv/work" }] });
      expect(nodesGetFunction.execute({ nodeId: SEEDED_NODE_ID }, ctx)).toEqual({
        ...localView, sources: [{ sourceId: defaultSource(project.id)!.id, projectId: project.id, projectName: "Listed", path: "/tmp/list-local" }],
      });
      expect(() => nodesGetFunction.execute({ nodeId: "gone" }, ctx)).toThrow("Node removed: gone");
      expect(() => nodesGetFunction.execute({ nodeId: "nowhere" }, ctx)).toThrow("Node not found: nowhere");
    } finally { box.stop(); state.nodes.close(); }
  });
});

describe("nodes.readFile, nodes.writeFile, nodes.copy and nodes.run", () => {
  useTestDb();

  /** Two real in-process nodes, the caller's (the seeded node) and "Mac mini", and a scratch directory
   * (both nodes share this machine's filesystem); `script` runs an `execute` script as the caller. */
  async function twoNodes() {
    const state = createAppState();
    const dir = mkdtempSync(join(tmpdir(), "reins-node-host-"));
    const project = createProject("Files", dir);
    getDb().exec("INSERT INTO nodes (id, name) VALUES ('mini', 'Mac mini'), ('away', 'Away')");
    connectLoopbackNode(state);
    connectLoopbackNode(state, { nodeId: "mini" });
    await loopbackLink(state).ready();
    await loopbackLink(state, "mini").ready();
    const ctx: ApiContext = { projectId: project.id, sessionId: "caller", taskId: null, broadcast: () => {}, sourceId: defaultSource(project.id)!.id, nodes: state.nodes, models: new Models(state) };
    return {
      dir,
      script: (code: string) => runScript(ctx, code),
      async stop() {
        await stopLoopbackNode(state);
        await stopLoopbackNode(state, "mini");
        await state.nodes.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  test("copies a file of any size from a node named by its name to another named by its ID, byte for byte, creating its directories; an empty one too", async () => {
    const { dir, script, stop } = await twoNodes();
    try {
      // Larger than a script may hold, and than one range of the copy.
      const bytes = new Uint8Array(20 * 1024 * 1024 + 3).map((_, i) => (i * 31) % 251);
      writeFileSync(join(dir, "video.mp4"), bytes);
      writeFileSync(join(dir, "empty.txt"), "");
      const result = await script(`
        const copied = await api.nodes.copy("mac MINI", ${JSON.stringify(join(dir, "video.mp4"))}, "internal", ${JSON.stringify(join(dir, "copies/new/video.mp4"))});
        const empty = await api.nodes.copy("mini", ${JSON.stringify(join(dir, "empty.txt"))}, "current", ${JSON.stringify(join(dir, "copies/empty.txt"))});
        return [copied, empty];`);
      expect(result).toEqual({ ok: true, text: JSON.stringify([{ bytes: bytes.length }, { bytes: 0 }], null, 2) });
      expect(readFileSync(join(dir, "copies/new/video.mp4")).equals(Buffer.from(bytes))).toBe(true);
      expect(readFileSync(join(dir, "copies/empty.txt"), "utf8")).toBe("");
      expect(await script(`return await api.nodes.copy("mini", ${JSON.stringify(join(dir, "missing.mp4"))}, "current", ${JSON.stringify(join(dir, "copies/missing.mp4"))});`))
        .toEqual({ ok: false, error: expect.stringContaining(`Cannot read ${join(dir, "missing.mp4")} on "Mac mini": ENOENT`) });
    } finally { await stop(); }
  });

  test("reads a binary file on a node and writes it on another, byte for byte, creating its directories", async () => {
    const { dir, script, stop } = await twoNodes();
    try {
      const bytes = Uint8Array.from({ length: 256 * 4 }, (_, i) => i % 256);
      writeFileSync(join(dir, "photo.png"), bytes);
      const result = await script(`
        const bytes = await api.nodes.readFile("mac MINI", ${JSON.stringify(join(dir, "photo.png"))}, { binary: true });
        await api.nodes.writeFile("internal", ${JSON.stringify(join(dir, "copies/new/photo.png"))}, bytes);
        return bytes.length;`);
      expect(result).toEqual({ ok: true, text: "1024" });
      expect(readFileSync(join(dir, "copies/new/photo.png"))).toEqual(Buffer.from(bytes));
    } finally { await stop(); }
  });

  test("writes text, and bytes the script made, on the caller's node; reads them back as text from another", async () => {
    const { dir, script, stop } = await twoNodes();
    try {
      const result = await script(`
        await api.nodes.writeFile("current", ${JSON.stringify(join(dir, "note.md"))}, "# Plans\\nCafé ☕\\n");
        await api.nodes.writeFile("current", ${JSON.stringify(join(dir, "hi.txt"))}, new Uint8Array([104, 105]));
        const note = await api.nodes.readFile("Mac mini", ${JSON.stringify(join(dir, "note.md"))});
        return { note, hi: await api.nodes.readFile("mini", ${JSON.stringify(join(dir, "hi.txt"))}) };`);
      expect(result).toEqual({ ok: true, text: JSON.stringify({ note: "# Plans\nCafé ☕\n", hi: "hi" }, null, 2) });
      expect(readFileSync(join(dir, "note.md"), "utf8")).toBe("# Plans\nCafé ☕\n");
    } finally { await stop(); }
  });

  test("~ is the node's home: relative paths and commands start there unless the command is given a cwd", async () => {
    const { dir, script, stop } = await twoNodes();
    try {
      writeFileSync(join(dir, "home.txt"), "found");
      const fromHome = relative(homedir(), join(dir, "home.txt"));
      const result = await script(`
        return [
          await api.nodes.readFile("mini", ${JSON.stringify(`~/${fromHome}`)}),
          await api.nodes.readFile("mini", ${JSON.stringify(fromHome)}),
          (await api.nodes.run("mini", "pwd")).output,
          (await api.nodes.run("mini", "pwd", { cwd: ${JSON.stringify(dir)} })).output,
        ];`);
      expect(result).toEqual({ ok: true, text: JSON.stringify(["found", "found", `${homedir()}\n`, `${dir}\n`], null, 2) });
    } finally { await stop(); }
  });

  test("a command's exit code and output come back, a failing one included; one past its timeout fails", async () => {
    const { script, stop } = await twoNodes();
    try {
      expect(await script(`return await api.nodes.run("current", "echo out; exit 3");`))
        .toEqual({ ok: true, text: JSON.stringify({ exitCode: 3, output: "out\n", truncated: false }, null, 2) });
      expect(await script(`return await api.nodes.run("Mac mini", "echo err >&2");`))
        .toEqual({ ok: true, text: JSON.stringify({ exitCode: 0, output: "err\n", truncated: false }, null, 2) });
      const timedOut = await script(`return await api.nodes.run("mini", "sleep 5", { timeoutMs: 200 });`);
      expect(timedOut).toEqual({ ok: false, error: 'Command timed out after 200 ms on "Mac mini"' });
    } finally { await stop(); }
  });

  test("a command's output is whole up to 16 MiB and truncated beyond; a file over 16 MiB is not read", async () => {
    const { dir, script, stop } = await twoNodes();
    try {
      const sizes = await script(`
        const outputs = [await api.nodes.run("mini", "head -c 2097152 /dev/zero | tr '\\\\0' a"), await api.nodes.run("mini", "head -c 17000000 /dev/zero | tr '\\\\0' b")];
        return outputs.map(run => ({ length: run.output.length, last: run.output.at(-1), truncated: run.truncated }));`);
      expect(sizes).toEqual({ ok: true, text: JSON.stringify([{ length: 2097152, last: "a", truncated: false }, { length: 16 * 1024 * 1024, last: "b", truncated: true }], null, 2) });
      mkdirSync(join(dir, "big"));
      writeFileSync(join(dir, "big/video.mp4"), "");
      truncateSync(join(dir, "big/video.mp4"), 16 * 1024 * 1024 + 1);
      const big = await script(`return (await api.nodes.readFile("mini", ${JSON.stringify(join(dir, "big/video.mp4"))}, { binary: true })).length;`);
      expect(big).toEqual({ ok: false, error: `Cannot read ${join(dir, "big/video.mp4")} on "Mac mini": it has 16777217 bytes, more than a script may hold (16 MiB). To copy it, use api.nodes.copy("mini", ${JSON.stringify(join(dir, "big/video.mp4"))}, toNode, toPath): it copies a file of any size.` });
    } finally { await stop(); }
  });

  test("a node that is not connected fails at once; an unknown one too, naming the nodes there are", async () => {
    const { script, stop } = await twoNodes();
    try {
      expect(await script(`return await api.nodes.run("Away", "true");`)).toEqual({ ok: false, error: 'Node unavailable: "Away" (away) is not connected' });
      expect(await script(`return await api.nodes.readFile("away", "~/notes.md");`)).toEqual({ ok: false, error: 'Node unavailable: "Away" (away) is not connected' });
      expect(await script(`return await api.nodes.writeFile("nowhere", "~/notes.md", "x");`)).toEqual({ ok: false, error: "Node not found: nowhere (the nodes: Away, Internal, Mac mini)" });
    } finally { await stop(); }
  });
});

describe("nodes.reload", () => {
  useTestDb();

  test("reloads the calling session's node by default, or the named one, and returns once the reload is scheduled; a refusal is the script's error", async () => {
    const state = createAppState();
    const project = createProject("Reload", "/tmp/reload-script");
    getDb().exec("INSERT INTO nodes (id, name) VALUES ('remote', 'Remote')");
    const remoteSource = createSource(project.id, "remote", "/tmp/reload-remote").id;
    const requests: Array<{ nodeId: string; force?: boolean }> = [];
    const local = connectScriptedNode(state, SEEDED_NODE_ID, { reload: async input => { requests.push({ nodeId: SEEDED_NODE_ID, ...input }); return { scheduled: true }; } });
    const refusal = "Nothing would restart this node (it is not supervised): restart it to load new code";
    const remote = connectScriptedNode(state, "remote", { reload: async () => {
      throw new NodeRejection("unavailable", refusal);
    } });
    const ctx = (sourceId: number): ApiContext => ({ projectId: project.id, sessionId: "caller", taskId: null, broadcast: () => {}, sourceId, nodes: state.nodes, models: new Models(state) });
    try {
      await local.ready();
      await remote.ready();
      expect(await nodesReloadFunction.execute({}, ctx(defaultSource(project.id)!.id))).toEqual({ nodeId: SEEDED_NODE_ID, scheduled: true });
      expect(await nodesReloadFunction.execute({ nodeId: SEEDED_NODE_ID, force: true }, ctx(remoteSource))).toEqual({ nodeId: SEEDED_NODE_ID, scheduled: true });
      expect(requests).toEqual([{ nodeId: SEEDED_NODE_ID, force: false }, { nodeId: SEEDED_NODE_ID, force: true }]);
      await expect(nodesReloadFunction.execute({}, ctx(remoteSource))).rejects.toThrow(refusal);
    } finally { local.stop(); remote.stop(); state.nodes.close(); }
  });
});

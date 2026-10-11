import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyShellOutputUpdate, BACKGROUND_CONTEXT, createBashTool, createEditTool, createReadTool, createWriteTool, withAbortSignal,
  type AgentHarnessTool, type Context, type ExecutionEnv, type ShellOutputUpdate, type ShellOutputView,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { REMOTE_MAX_FRAME_BYTES } from "@reins/node-protocol";
import { startNode, type Node } from "@reins/node/node";
import { RemoteExecutionEnv } from "../../sessions/remote-env.js";
import type { ServerState } from "../../state.js";
import { createServerState } from "../helpers/server-state.js";
import { dialLoopback, SEEDED_NODE_ID, type LoopbackLink } from "../helpers/loopback-node.js";
import { useTestDb } from "../helpers/test-db.js";

useTestDb();
setDefaultTimeout(30_000);

let dir: string;
let state: ServerState;
const nodes: Node[] = [];
const links: LoopbackLink[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "reins-remote-env-"));
  state = createServerState();
});
afterEach(async () => {
  for (const link of links.splice(0)) link.stop();
  await Promise.all(nodes.splice(0).map(node => node.shutdown()));
  state.nodes.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A node linked to the hub as the seeded node, over the remote link's frame cap. */
async function linkNode(node = startNode(), { redial = true } = {}) {
  if (!nodes.includes(node)) nodes.push(node);
  const link = dialLoopback(state, node, { redial, maxFrameBytes: REMOTE_MAX_FRAME_BYTES });
  links.push(link);
  await link.ready();
  return { node, link };
}

/** The environment of a session whose checkout is `cwd` on the seeded node, reached through whichever
 * hub the state has now. */
const remoteEnv = (cwd = dir, windows: { retryWindowMs?: number; reattachWindowMs?: number } = {}) =>
  new RemoteExecutionEnv({ sourceId: 1, cwd, nodeFor: async () => state.nodes.get(SEEDED_NODE_ID), ...windows });

const invocation = { invocationId: "call", operationId: "operation", turnId: "turn", async getMemo() { return undefined; }, async setMemo() {} };
type HostTool = AgentHarnessTool<{ env: ExecutionEnv }>;
const tools: Record<string, HostTool> = {
  read: createReadTool(), write: createWriteTool(), edit: createEditTool(), bash: createBashTool(),
};
/** What a tool call comes to: its text, images and details, or the error it throws (message and Pi's
 * error code). */
interface Outcome { text?: string; images?: Array<{ data: string; mimeType: string }>; details?: unknown; error?: string; code?: unknown }
async function call(env: ExecutionEnv, name: string, params: Record<string, unknown>, context: Context = BACKGROUND_CONTEXT): Promise<Outcome> {
  try {
    const { content, details } = await tools[name]!.execute("call", params, () => undefined, { env }, invocation, context);
    return {
      text: content.flatMap(block => block.type === "text" ? [block.text] : []).join(""),
      images: content.flatMap(block => block.type === "image" ? [{ data: block.data, mimeType: block.mimeType }] : []),
      details,
    };
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    return { error: failure.message, ...("code" in failure ? { code: failure.code } : {}) };
  }
}

/** Runs `steps` on a fresh copy of the checkout (`setup`) with the local environment and then the remote
 * one, and returns both runs' results and what each left in the checkout. */
async function bothEnvs<T>(setup: () => void, steps: (env: ExecutionEnv) => Promise<T>) {
  await linkNode();
  const runs: Array<{ results: T; files: Record<string, string> }> = [];
  for (const env of [new NodeExecutionEnv({ cwd: dir }), remoteEnv()]) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    setup();
    runs.push({ results: await steps(env), files: snapshot(dir) });
  }
  return runs;
}
function snapshot(root: string, prefix = ""): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of new Bun.Glob("**/*").scanSync({ cwd: root, dot: true })) files[prefix + entry] = readFileSync(join(root, entry)).toString("base64");
  return files;
}

/** A 1×1 PNG. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

test("Pi's read, write and edit tools come to the same results on the node as on a local environment: text, images, missing files and edits", async () => {
  const [local, remote] = await bothEnvs(() => {
    writeFileSync(join(dir, "notes.txt"), "alpha\nbeta\ngamma\n");
    writeFileSync(join(dir, "pixel.png"), PNG);
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
  }, async env => [
    await call(env, "read", { path: "notes.txt", offset: 2, limit: 1 }),
    await call(env, "read", { path: join(dir, "pixel.png") }),
    await call(env, "read", { path: "missing.txt" }),
    await call(env, "read", { path: "src" }),
    await call(env, "write", { path: "new/deep/file.txt", content: "written\n" }),
    await call(env, "edit", { path: "src/a.ts", edits: [{ oldText: "a = 1", newText: "a = 2" }] }),
    await call(env, "edit", { path: "src/a.ts", edits: [{ oldText: "not there", newText: "x" }] }),
    await call(env, "edit", { path: "missing.ts", edits: [{ oldText: "a", newText: "b" }] }),
  ]);
  expect(remote).toEqual(local!);
  // The results are real ones, not two identical failures.
  const results = local!.results;
  expect(results[1]!.images).toEqual([{ data: PNG.toString("base64"), mimeType: "image/png" }]);
  expect(results[2]!.error).toContain("ENOENT");
  expect(local!.files).toMatchObject({ "new/deep/file.txt": Buffer.from("written\n").toString("base64"), "src/a.ts": Buffer.from("export const a = 2;\n").toString("base64") });
});

const line = (i: number) => `line ${i} ${"é".repeat(40)}\n`;

test("files larger than a frame cross in slices: a write and a read of more than the remote frame cap", async () => {
  const content = Array.from({ length: Math.ceil(REMOTE_MAX_FRAME_BYTES / 80) + 1000 }, (_, i) => line(i)).join("");
  expect(Buffer.byteLength(content)).toBeGreaterThan(REMOTE_MAX_FRAME_BYTES);
  const [local, remote] = await bothEnvs(() => {}, async env => [
    await call(env, "write", { path: "big.txt", content }),
    await call(env, "read", { path: "big.txt", offset: 200_000, limit: 3 }),
    await call(env, "edit", { path: "big.txt", edits: [{ oldText: line(150_000), newText: "replaced\n" }] }),
  ]);
  expect(remote).toEqual(local!);
  const [written, read, edited] = local!.results;
  expect(written!.error).toBeUndefined();
  expect(read!.text).toStartWith(`${line(199_999)}${line(200_000)}${line(200_001)}`.trimEnd());
  expect(edited!.error).toBeUndefined();
});

test("bash comes to the same results on the node: output, exit codes, a truncated output's spill file, a timeout and an abort", async () => {
  const big = "for i in $(seq 1 3000); do echo \"row $i\"; done";
  const [local, remote] = await bothEnvs(() => {}, async env => {
    const aborted = new AbortController();
    const results = [
      await call(env, "bash", { command: "echo out; echo err >&2; printf '%s' \"$PI_TEST_VALUE\"" }),
      await call(env, "bash", { command: "pwd; echo partial; exit 3" }),
      await call(env, "bash", { command: big }),
      await call(env, "bash", { command: "echo started; sleep 5", timeout: 0.3 }),
      await Promise.all([
        call(env, "bash", { command: "echo started; sleep 5" }, withAbortSignal(aborted.signal, BACKGROUND_CONTEXT)),
        Bun.sleep(200).then(() => aborted.abort()),
      ]).then(([result]) => result),
    ];
    // The spill file is the environment's own: its path differs between runs, its content does not.
    const path = /Full output: (\S+)\]$/.exec(results[2]!.text ?? "")![1]!;
    const unspilled: Outcome[] = JSON.parse(JSON.stringify(results).replaceAll(path, "<spill>"));
    return { results: unspilled, spill: readFileSync(path, "utf8") };
  });
  expect(remote).toEqual(local!);
  const { results, spill } = local!.results;
  expect(results[0]!.text).toBe("out\nerr\n");
  expect(results[1]!.error).toBe(`${dir}\npartial\n\n\nCommand exited with code 3`);
  expect(results[2]!.text).toEndWith("[Showing lines 1001-3000 of 3000. Full output: <spill>]");
  expect(spill.split("\n")).toHaveLength(3001);
  expect(results[3]!.error).toBe("started\n\n\nCommand timed out after 0.3 seconds");
  expect(results[4]!.error).toBe("started\n\n\nCommand aborted");
});

/** Runs `command` through `env` and collects its view as Pi's bash tool does. */
function exec(env: ExecutionEnv, command: string, onView: (view: ShellOutputView, update: ShellOutputUpdate) => void = () => {}, context: Context = BACKGROUND_CONTEXT) {
  let view: ShellOutputView | undefined;
  const result = env.exec(command, {
    capture: { limits: { maxBytes: 50 * 1024, maxLines: 2000, retain: "tail" }, spill: true },
    onUpdate: update => { view = applyShellOutputUpdate(view, update); onView(view, update); },
  }, context);
  return { result, view: () => view?.text ?? "" };
}
const counting = (lines: number, pause: number) => `for i in $(seq 1 ${lines}); do echo "line $i"; sleep ${pause}; done`;
const numbered = (lines: number) => Array.from({ length: lines }, (_, i) => `line ${i + 1}\n`).join("");

test("an exec goes on through a dropped link: the output continues into the same call from where it stopped, nothing lost or doubled", async () => {
  const { link } = await linkNode();
  let dropped = false;
  const run = exec(remoteEnv(), counting(40, 0.02), view => {
    if (!dropped && view.text.includes("line 10\n")) { dropped = true; link.drop(); }
  });
  expect(await run.result).toMatchObject({ ok: true, value: { exitCode: 0 } });
  expect(dropped).toBe(true);
  expect(run.view()).toBe(numbered(40));
});

test("output the node no longer keeps when the server comes back is replaced by the command's current view", async () => {
  const node = startNode({ execTailBytes: 256 });
  const { link } = await linkNode(node, { redial: false });
  let dropped = false;
  const afterDrop: string[] = [];
  const run = exec(remoteEnv(dir, { reattachWindowMs: 10_000 }), counting(60, 0.01), (view, update) => {
    if (dropped) afterDrop.push(update.kind);
    else if (view.text.includes("line 5\n")) { dropped = true; link.drop(); }
  });
  await Bun.sleep(300);
  await linkNode(node);
  expect(await run.result).toMatchObject({ ok: true, value: { exitCode: 0 } });
  expect(afterDrop[0]).toBe("replace");
  expect(run.view()).toBe(numbered(60));
});

/** The PID a command wrote to `file`, once it has. */
async function pidIn(file: string) {
  for (let i = 0; i < 400 && !existsSync(file); i++) await Bun.sleep(5);
  return Number(readFileSync(file, "utf8"));
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (done: () => boolean) => { for (let i = 0; i < 400 && !done(); i++) await Bun.sleep(5); expect(done()).toBe(true); };

test("a command whose server stays away past the grace period is killed and forgotten: the call's outcome is unknown", async () => {
  const node = startNode({ execGraceMs: 100 });
  const { link } = await linkNode(node, { redial: false });
  const run = exec(remoteEnv(dir, { reattachWindowMs: 10_000 }), `echo $$ > ${join(dir, "pid")}; exec sleep 30`);
  const pid = await pidIn(join(dir, "pid"));
  link.drop();
  await until(() => !alive(pid));
  await linkNode(node);
  expect(await run.result).toMatchObject({ ok: false, error: { code: "unknown", message: expect.stringContaining("outcome is unknown") } });
});

test("a command on a node that restarted is not known there: the call's outcome is unknown", async () => {
  const { node, link } = await linkNode(startNode(), { redial: false });
  const run = exec(remoteEnv(dir, { reattachWindowMs: 10_000 }), `echo $$ > ${join(dir, "pid")}; exec sleep 30`);
  const pid = await pidIn(join(dir, "pid"));
  link.stop();
  await node.shutdown();
  await until(() => !alive(pid));
  await linkNode(startNode());
  expect(await run.result).toMatchObject({ ok: false, error: { code: "unknown", message: expect.stringContaining("outcome is unknown") } });
});

test("a node reload waits for a running command, which completes through it; a command started while it waits runs on the restarted node", async () => {
  const restarted = Promise.withResolvers<void>();
  let restarts = 0;
  const node: Node = startNode({
    reload: {
      check: async () => {},
      // As the node process does: stop the link and the node, then the next node links.
      restart: () => { restarts++; void (async () => { link.stop(); await node.shutdown(); await linkNode(); restarted.resolve(); })(); },
    },
  });
  const { link } = await linkNode(node, { redial: false });
  const env = remoteEnv();
  const release = join(dir, "release");
  const first = exec(env, `echo started; while [ ! -e ${release} ]; do sleep 0.01; done; echo finished`);
  await until(() => first.view() === "started\n");
  expect(await state.nodes.get(SEEDED_NODE_ID).request("node.reload", {})).toEqual({ scheduled: true });
  const second = exec(env, "echo second");
  await Bun.sleep(200);
  expect(restarts).toBe(0);

  writeFileSync(release, "");
  expect(await first.result).toMatchObject({ ok: true, value: { exitCode: 0 } });
  expect(first.view()).toBe("started\nfinished\n");
  await restarted.promise;
  expect(await second.result).toMatchObject({ ok: true, value: { exitCode: 0 } });
  expect(second.view()).toBe("second\n");
  expect(restarts).toBe(1);
});

test("aborting an exec kills its process on the node, and cleanup kills what the environment still runs", async () => {
  await linkNode();
  const env = remoteEnv();
  const aborted = new AbortController();
  const run = exec(env, `echo $$ > ${join(dir, "aborted")}; exec sleep 30`, () => {}, withAbortSignal(aborted.signal, BACKGROUND_CONTEXT));
  const pid = await pidIn(join(dir, "aborted"));
  aborted.abort();
  expect(await run.result).toMatchObject({ ok: false, error: { code: "aborted" } });
  expect(alive(pid)).toBe(false);

  const left = exec(env, `echo $$ > ${join(dir, "left")}; exec sleep 30`);
  const other = await pidIn(join(dir, "left"));
  await env.cleanup(BACKGROUND_CONTEXT);
  expect(await left.result).toMatchObject({ ok: false });
  expect(alive(other)).toBe(false);
});

import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyShellOutputUpdate, BACKGROUND_CONTEXT, createBashTool, createEditTool, createReadTool, createWriteTool, withAbortSignal,
  type AgentHarnessTool, type Context, type ExecutionEnv, type ShellOutputUpdate, type ShellOutputView,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { REMOTE_MAX_FRAME_BYTES, RpcFailure } from "@reins/node-protocol";
import { startNode, type Node } from "@reins/node/node";
import { RemoteExecutionEnv, type CommandCall } from "../../sessions/remote-env.js";
import { sessionNode } from "../../session-runtime/build.js";
import { checkoutResources } from "../../session-runtime/resources.js";
import { setNodeRemoved } from "../../node-store.js";
import type { RemoteNode } from "../../state.js";
import { createAppState, type TestAppState } from "../helpers/app-state.js";
import { dialLoopback, SEEDED_NODE_ID, type LoopbackLink } from "../helpers/loopback-node.js";
import { useTestDb } from "../helpers/test-db.js";

useTestDb();
setDefaultTimeout(30_000);

let dir: string;
let state: TestAppState;
const nodes: Node[] = [];
const links: LoopbackLink[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "reins-remote-env-"));
  state = createAppState();
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

test("the checkout's context files and skills are discovered on the node as on a local environment: directory listings, symlinked skills, ignore files and paths", async () => {
  const [local, remote] = await bothEnvs(() => {
    writeFileSync(join(dir, "AGENTS.md"), "project instructions");
    const skills = join(dir, ".agents", "skills");
    mkdirSync(join(skills, "review"), { recursive: true });
    writeFileSync(join(skills, "review", "SKILL.md"), "---\nname: review\ndescription: Reviews code\n---\n\nRead the diff.");
    mkdirSync(join(dir, "elsewhere", "deploy"), { recursive: true });
    writeFileSync(join(dir, "elsewhere", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: Deploys\n---\nShip it.");
    symlinkSync(join(dir, "elsewhere", "deploy"), join(skills, "deploy"));
    mkdirSync(join(skills, "ignored"));
    writeFileSync(join(skills, "ignored", "SKILL.md"), "---\nname: ignored\ndescription: Ignored\n---\n");
    writeFileSync(join(skills, ".gitignore"), "ignored/\n");
  }, async env => {
    const listed = await env.listDir(".agents/skills", BACKGROUND_CONTEXT);
    return {
      resources: await checkoutResources(env, BACKGROUND_CONTEXT),
      listed: listed.ok ? listed.value.map(({ name, path, kind }) => ({ name, path, kind })).toSorted((a, b) => a.name.localeCompare(b.name)) : listed.error.code,
      missing: await env.listDir("missing", BACKGROUND_CONTEXT).then(result => result.ok || result.error.code),
      exists: [await env.exists("AGENTS.md", BACKGROUND_CONTEXT), await env.exists("missing", BACKGROUND_CONTEXT)],
      canonical: await env.canonicalPath(".agents/skills/deploy", BACKGROUND_CONTEXT),
      absolute: await env.absolutePath("~/notes", BACKGROUND_CONTEXT),
    };
  });
  expect(remote).toEqual(local!);
  const { resources, listed } = local!.results;
  expect(resources.contextFiles.filter(file => file.path.startsWith(dir))).toEqual([{ path: join(dir, "AGENTS.md"), content: "project instructions" }]);
  expect(resources.skills.map(found => [found.name, found.content]).toSorted()).toEqual([["deploy", "Ship it."], ["review", "Read the diff."]]);
  expect(listed).toContainEqual({ name: "deploy", path: join(dir, ".agents", "skills", "deploy"), kind: "symlink" });
});

const away = async (): Promise<never> => { throw new Error("Node 1 is not connected"); };
test("a strict environment throws a file operation its node did not answer, so a discovery is never taken for a checkout without files; a plain one answers Pi's file error", async () => {
  const strict = new RemoteExecutionEnv({ sourceId: 1, cwd: dir, nodeFor: away, strict: true });
  await expect(strict.readTextFile("AGENTS.md", BACKGROUND_CONTEXT)).rejects.toThrow("Node 1 is not connected");
  await expect(checkoutResources(strict, BACKGROUND_CONTEXT)).rejects.toThrow("Node 1 is not connected");
  const plain = new RemoteExecutionEnv({ sourceId: 1, cwd: dir, nodeFor: away });
  expect(await plain.readTextFile("AGENTS.md", BACKGROUND_CONTEXT)).toMatchObject({ ok: false, error: { code: "unknown", message: "Node 1 is not connected" } });
  // A file the node answers is missing is the file's own failure, strict or not.
  await linkNode();
  const answered = new RemoteExecutionEnv({ sourceId: 1, cwd: dir, nodeFor: async () => state.nodes.get(SEEDED_NODE_ID), strict: true });
  expect(await answered.readTextFile("AGENTS.md", BACKGROUND_CONTEXT)).toMatchObject({ ok: false, error: { code: "not_found" } });
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
function exec(env: Pick<ExecutionEnv, "exec">, command: string, onView: (view: ShellOutputView, update: ShellOutputUpdate) => void = () => {}, context: Context = BACKGROUND_CONTEXT) {
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

/** The environment of a session on the seeded node as runtimes reach it, through the current app's hub (a
 * removed node is refused there; none during a reload's gap: `sessionNode`). */
const appEnv = (windows: { retryWindowMs?: number; reattachWindowMs?: number } = {}) =>
  new RemoteExecutionEnv({ sourceId: 1, cwd: dir, nodeFor: async () => sessionNode(state.process, SEEDED_NODE_ID), ...windows });

test("a file operation and a command started while the node is offline wait for it however long, and run once it connects", async () => {
  writeFileSync(join(dir, "notes.txt"), "waited for\n");
  // The windows bound only retrying a call whose outcome is unknown and reattaching a command.
  const env = appEnv({ retryWindowMs: 20, reattachWindowMs: 20 });
  const read = call(env, "read", { path: "notes.txt" });
  const run = exec(env, "echo ran");
  await Bun.sleep(300);
  await linkNode();
  expect(await read).toMatchObject({ text: "waited for\n" });
  expect(await run.result).toMatchObject({ ok: true, value: { exitCode: 0 } });
  expect(run.view()).toBe("ran\n");
});

test("a call waiting for its node stops when it is aborted, and fails when the node is removed", async () => {
  const env = appEnv();
  const aborted = new AbortController();
  const context = withAbortSignal(aborted.signal, BACKGROUND_CONTEXT);
  const waiting = [call(env, "read", { path: "notes.txt" }, context), exec(env, "echo never", () => {}, context).result];
  await Bun.sleep(100);
  aborted.abort();
  expect(await Promise.all(waiting)).toEqual([{ error: "aborted", code: "aborted" }, expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "aborted" }) })]);

  const read = call(env, "read", { path: "notes.txt" });
  const run = exec(env, "echo never").result;
  await Bun.sleep(100);
  setNodeRemoved(SEEDED_NODE_ID, new Date().toISOString());
  expect(await read).toMatchObject({ error: expect.stringContaining("Node removed") });
  expect(await run).toMatchObject({ ok: false, error: { code: "spawn_error", message: expect.stringContaining("Node removed") } });
});

const unexpected = async (): Promise<never> => { throw new Error("unexpected call"); };

test("a file operation whose outcome is unknown after it was sent is sent again only within the retry window, counted from that failure", async () => {
  let attempts = 0;
  let connectedAt = Infinity;
  // A node that is offline for longer than the window, then loses every answer once connected.
  const lost = async (): Promise<never> => {
    attempts++;
    if (Date.now() < connectedAt) throw new RpcFailure("unavailable", "Node not connected");
    throw new RpcFailure("unavailable", "Connection closed", "unknown");
  };
  const lossy: RemoteNode = { id: SEEDED_NODE_ID, connected: true, build: null, docs: null, request: lost, openStream: lost, spawn: unexpected };
  const env = new RemoteExecutionEnv({ sourceId: 1, cwd: dir, nodeFor: async () => lossy, retryWindowMs: 200 });
  connectedAt = Date.now() + 300;
  const started = Date.now();
  const result = await call(env, "read", { path: "notes.txt" });
  expect(result.error).toContain("Connection closed");
  expect(Date.now() - started).toBeGreaterThanOrEqual(500);
  expect(attempts).toBeGreaterThan(2);
});

/** `env`'s commands under `call` (`execCommand`), as a tool call that recorded the command's ID runs them. */
const under = (env: RemoteExecutionEnv, commandCall: CommandCall): Pick<ExecutionEnv, "exec"> => ({ exec: (command, options, context) => env.execCommand(commandCall, command, options, context) });
/** An environment like `remoteEnv`'s that records the node methods it calls. */
function recordingEnv() {
  const sent: string[] = [];
  const env = new RemoteExecutionEnv({
    sourceId: 1, cwd: dir, reattachWindowMs: 10_000,
    nodeFor: async () => {
      const node = state.nodes.get(SEEDED_NODE_ID);
      return new Proxy(node, {
        get(target, property) {
          const value: unknown = Reflect.get(target, property, target);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => { if (typeof args[0] === "string" && property !== "spawn") sent.push(args[0]); return Reflect.apply(value, target, args); };
        },
      });
    },
  });
  return { env, sent };
}

test("a detached environment (its server suspends its sessions) leaves its commands running: an abort only stops reading and cleanup kills nothing; the next server process picks a command up by its ID alone, from the start of its output to its exit, without sending it again", async () => {
  await linkNode();
  const first = remoteEnv();
  const execId = crypto.randomUUID();
  const release = join(dir, "release");
  const aborted = new AbortController();
  const command = `echo start >> runs.log; echo started; while [ ! -e ${release} ]; do sleep 0.01; done; echo done`;
  const cutOff = exec(under(first, { execId, attach: false }), command, () => {}, withAbortSignal(aborted.signal, BACKGROUND_CONTEXT));
  await until(() => cutOff.view() === "started\n");
  first.detach();
  aborted.abort();
  expect(await cutOff.result).toMatchObject({ ok: false, error: { code: "aborted" } });
  await first.cleanup(BACKGROUND_CONTEXT);

  const { env: next, sent } = recordingEnv();
  const picked = exec(under(next, { execId, attach: true }), "echo never sent");
  await until(() => picked.view() === "started\n");
  writeFileSync(release, "");
  expect(await picked.result).toMatchObject({ ok: true, value: { exitCode: 0 } });
  expect(picked.view()).toBe("started\ndone\n");
  expect(readFileSync(join(dir, "runs.log"), "utf8")).toBe("start\n");
  expect(sent).not.toContain("pi.exec");
  expect(sent).toContain("pi.execAttach");
});

test("picking up a command the node does not know (it restarted, or it was never sent) is outcome unknown, and never sends it", async () => {
  await linkNode();
  const { env, sent } = recordingEnv();
  const picked = exec(under(env, { execId: crypto.randomUUID(), attach: true }), `echo ran >> ${join(dir, "runs.log")}`);
  expect(await picked.result).toMatchObject({ ok: false, error: { code: "unknown", message: expect.stringContaining("outcome is unknown") } });
  expect(sent).toEqual(["pi.execAttach"]);
  expect(existsSync(join(dir, "runs.log"))).toBe(false);
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

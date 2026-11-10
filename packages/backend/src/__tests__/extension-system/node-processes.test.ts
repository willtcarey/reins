import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { NodeProcess, ServerSdk } from "@reins/sdk/server";
import { useTestDb } from "../helpers/test-db.js";
import { createAppState, type TestAppState } from "../helpers/app-state.js";
import { connectLoopbackNode, loopbackLink, stopLoopbackNode } from "../helpers/loopback-node.js";
import { getDb } from "../../app-globals.js";
import { runScript } from "../../tools/execute.js";
import { scriptContext } from "../helpers/script-context.js";

const until = async (condition: () => boolean) => { for (let i = 0; i < 400 && !condition(); i++) await Bun.sleep(5); expect(condition()).toBe(true); };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** The lines a process prints, as they come. */
function reading(proc: NodeProcess) {
  const lines: string[] = [];
  const done = (async () => { for await (const line of proc.lines) lines.push(line); })().then(() => null, (error: Error) => error);
  return { lines, done };
}

describe("reins.nodes.spawn", () => {
  useTestDb();
  let state: TestAppState;
  let reins: ServerSdk;

  beforeEach(async () => {
    getDb().exec("INSERT INTO nodes (id, name) VALUES ('mini', 'Mac mini'), ('away', 'Away')");
    state = createAppState(undefined, { extensions: [{ name: "checks", register: sdk => { reins = sdk; return () => {}; } }] });
    connectLoopbackNode(state, { nodeId: "mini" });
    await loopbackLink(state, "mini").ready();
  });
  afterEach(async () => {
    await state.extensions.dispose();
    await stopLoopbackNode(state, "mini");
    await state.nodes.close();
  });

  test("writes to a process's stdin and reads its stdout as whole lines, however they were split", async () => {
    const proc = await reins.nodes.spawn("mini", ["sh", "-c", "while read line; do printf '{\"echo\":'; sleep 0.05; printf '%s}\\n' \"$line\"; done"]);
    const { lines, done } = reading(proc);

    await proc.write("1\n");
    await proc.write(new TextEncoder().encode("2\r\n"));
    await until(() => lines.length === 2);
    await proc.closeInput();

    expect(await done).toBeNull();
    expect(lines).toEqual(["{\"echo\":1}", "{\"echo\":2\r}"]);
    expect(await proc.exited).toEqual({ code: 0, signal: null });
    await expect(proc.write("late\n")).rejects.toThrow("The process has exited");
  });

  test("gives the last line without a newline, and raw chunks when asked", async () => {
    const lines = reading(await reins.nodes.spawn("mini", "printf 'one\\ntwo'"));
    const raw = await reins.nodes.spawn("mini", "printf 'a\\nb'");
    const chunks: string[] = [];
    for await (const chunk of raw.chunks) chunks.push(Buffer.from(chunk).toString());

    expect(await lines.done).toBeNull();
    expect(lines.lines).toEqual(["one", "two"]);
    expect(chunks.join("")).toBe("a\nb");
    expect(() => raw.lines[Symbol.asyncIterator]().next()).toThrow("A process's stdout is read once: as lines or as chunks");
  });

  test("a line longer than maxLineBytes fails the reading clearly and stops the process", async () => {
    const proc = await reins.nodes.spawn("mini", "echo ok; printf '%s' 0123456789abcdef; sleep 100", { maxLineBytes: 10 });
    const { lines, done } = reading(proc);

    expect(await done).toMatchObject({ message: "A line of its stdout was longer than 10 bytes" });
    expect(lines).toEqual(["ok"]);
    expect(await proc.exited).toEqual({ code: null, signal: "SIGTERM", error: "A line of its stdout was longer than 10 bytes" });
  });

  test("keeps the tail of its stderr, tells listeners as it comes, and its exit code", async () => {
    const proc = await reins.nodes.spawn("mini", "echo starting >&2; read token; echo \"bad token: $token\" >&2; exit 2", { env: { UNUSED: "x" } });
    const heard: string[] = [];
    proc.onStderr(text => heard.push(text));
    await until(() => proc.stderrTail() === "starting\n");
    await proc.write("abc\n");

    expect(await proc.exited).toEqual({ code: 2, signal: null });
    expect(proc.stderrTail()).toBe("starting\nbad token: abc\n");
    expect(heard.join("")).toContain("bad token: abc\n");
  });

  test("stop ends it and what it started; the signal given stops it too", async () => {
    const proc = await reins.nodes.spawn("mini", "sleep 100 & echo $!; wait");
    const { lines } = reading(proc);
    await until(() => lines.length === 1);

    expect(await proc.stop()).toEqual({ code: null, signal: "SIGTERM" });
    await until(() => !alive(Number(lines[0])));

    const controller = new AbortController();
    const signalled = await reins.nodes.spawn("mini", ["sleep", "100"], { signal: controller.signal });
    controller.abort();
    expect(await signalled.exited).toEqual({ code: null, signal: "SIGTERM" });
  });

  test("a process whose node link drops is stopped there, and its exit says why", async () => {
    const proc = await reins.nodes.spawn("mini", ["sleep", "100"]);

    loopbackLink(state, "mini").drop();

    expect(await proc.exited).toEqual({ code: null, signal: null, error: "The node's link dropped, which stopped the process" });
    await until(() => !alive(proc.pid));
  });

  test("unloading the extension stops its processes", async () => {
    const proc = await reins.nodes.spawn("mini", ["sleep", "100"]);

    await state.extensions.dispose();

    expect(await proc.exited).toEqual({ code: null, signal: "SIGTERM" });
    expect(alive(proc.pid)).toBe(false);
  });

  test("refuses a blank command, a bad environment variable, a node unknown or not connected, a missing directory or program", async () => {
    await expect(reins.nodes.spawn("mini", " ")).rejects.toThrow("A command is a non-blank string or an array of strings naming a program");
    await expect(reins.nodes.spawn("mini", [])).rejects.toThrow("A command is a non-blank string");
    await expect(reins.nodes.spawn("mini", "true", { env: { "BAD-NAME": "x" } })).rejects.toThrow("Not an environment variable: BAD-NAME");
    await expect(reins.nodes.spawn("nowhere", "true")).rejects.toThrow("Node not found: nowhere");
    await expect(reins.nodes.spawn("away", "true")).rejects.toThrow('Node unavailable: "Away" (away) is not connected');
    await expect(reins.nodes.spawn("mini", "true", { cwd: "/nonexistent/reins" })).rejects.toThrow('Cannot start true on "Mac mini": Directory not found: /nonexistent/reins');
    await expect(reins.nodes.spawn("Mac mini", ["no-such-program-reins"])).rejects.toThrow('Cannot start no-such-program-reins on "Mac mini": Program not found: no-such-program-reins');
  });

  test("agents' scripts have no spawn: a process would outlive the script", async () => {
    const result = await runScript(scriptContext(state), "return typeof reins.nodes.spawn");

    expect(result).toMatchObject({ ok: true, text: "undefined" });
  });
});

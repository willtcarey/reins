import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { outputParser } from "@reins/node-protocol";
import { startNode, type Node } from "./node.js";

const until = async (condition: () => boolean) => { for (let i = 0; i < 400 && !condition(); i++) await Bun.sleep(5); expect(condition()).toBe(true); };
const base64 = (text: string) => Buffer.from(text).toString("base64");
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Starts a process on `node` and reads its output stream as the connection would: `stdout()` and `stderr()` are
 * what it printed so far, `output()` both in the order they came, `exit` its stream's end, `stopStream()` stops
 * the stream (a cancel, or the link lost). */
async function started(node: Node, input: { argv?: string[]; command?: string; env?: Record<string, string>; cwd?: string; stdin?: boolean }) {
  const processId = crypto.randomUUID();
  const { result, source } = await node.startProcess({ cwd: input.cwd ?? tmpdir(), streamId: crypto.randomUUID(), processId, ...input });
  const stream = new AbortController();
  const output: { channel: "stdout" | "stderr"; text: string }[] = [];
  const parser = outputParser((channel, bytes) => output.push({ channel, text: Buffer.from(bytes).toString("utf8") }));
  const exit = (async () => {
    const iterator = source(stream.signal)[Symbol.asyncIterator]();
    for (;;) {
      const step = await iterator.next();
      if (step.done) { parser.end(); return step.value || undefined; }
      parser.push(typeof step.value === "string" ? Buffer.from(step.value) : step.value);
    }
  })();
  const of = (channel: "stdout" | "stderr") => output.filter(part => part.channel === channel).map(part => part.text).join("");
  return { processId, pid: result.pid, exit, stdout: () => of("stdout"), stderr: () => of("stderr"), output: () => output, stopStream: () => stream.abort() };
}

test("a process reads what the server writes to its stdin, its stdout streams back, and closing its input ends it", async () => {
  const node = startNode();
  try {
    const cat = await started(node, { argv: ["cat"] });
    await node.writeProcess({ processId: cat.processId, data: base64("{\"jsonrpc\":\"2.0\",\"id\":1}\n") });
    await until(() => cat.stdout() === "{\"jsonrpc\":\"2.0\",\"id\":1}\n");
    await node.writeProcess({ processId: cat.processId, data: base64("bye"), end: true });

    expect(await cat.exit).toEqual({ code: 0, signal: null });
    expect(cat.stdout()).toBe("{\"jsonrpc\":\"2.0\",\"id\":1}\nbye");
    await expect(node.writeProcess({ processId: cat.processId, data: base64("late") })).rejects.toMatchObject({ error: { code: "not_found" } });
  } finally { await node.shutdown(); }
});

test("a process started without stdin reads nothing and takes no input", async () => {
  const node = startNode();
  try {
    const reader = await started(node, { command: "cat; echo done", stdin: false });

    expect(await reader.exit).toEqual({ code: 0, signal: null });
    expect(reader.stdout()).toBe("done\n");
    await expect(node.writeProcess({ processId: reader.processId, end: true })).rejects.toMatchObject({ error: { code: "not_found" } });
  } finally { await node.shutdown(); }
});

test("a shell command runs in its directory with its environment added to the node's, and its exit carries its code", async () => {
  const node = startNode();
  const cwd = mkdtempSync(join(tmpdir(), "reins-process-"));
  try {
    const shell = await started(node, { command: "pwd; printf '%s|%s\\n' \"$API_KEY\" \"${HOME:+home}\"; echo oops >&2; exit 3", env: { API_KEY: "it's $ecret" }, cwd });

    expect(await shell.exit).toEqual({ code: 3, signal: null });
    expect(shell.stdout()).toBe(`${cwd}\nit's $ecret|home\n`);
    expect(shell.stderr()).toBe("oops\n");
  } finally { await node.shutdown(); }
});

test("stdout and stderr come in one stream, in the order the node read them, which ends only once the process exited and both pipes closed", async () => {
  const node = startNode();
  try {
    const proc = await started(node, { command: "echo starting >&2; read line; echo \"got $line\"; echo \"failed: $line\" >&2" });
    await until(() => proc.stderr() === "starting\n");
    await node.writeProcess({ processId: proc.processId, data: base64("no token\n") });

    expect(await proc.exit).toEqual({ code: 0, signal: null });
    expect(proc.output()).toEqual([
      { channel: "stderr", text: "starting\n" }, { channel: "stdout", text: "got no token\n" }, { channel: "stderr", text: "failed: no token\n" },
    ]);
  } finally { await node.shutdown(); }
});

test("stopping sends SIGTERM, then SIGKILL after the grace period to a process that ignores it", async () => {
  const node = startNode({ processStopGraceMs: 200 });
  try {
    const polite = await started(node, { argv: ["sleep", "100"] });
    const stubborn = await started(node, { command: "trap '' TERM; echo ready; while true; do sleep 0.05; done" });
    await until(() => stubborn.stdout() === "ready\n");

    expect(await node.stopProcess({ processId: polite.processId })).toEqual({ stopping: true });
    expect(await node.stopProcess({ processId: stubborn.processId })).toEqual({ stopping: true });

    expect(await polite.exit).toEqual({ code: null, signal: "SIGTERM" });
    expect(await stubborn.exit).toEqual({ code: null, signal: "SIGKILL" });
    await expect(node.stopProcess({ processId: polite.processId })).rejects.toMatchObject({ error: { code: "not_found" } });
  } finally { await node.shutdown(); }
});

test("stopping stops the whole process group: a child of the process does not outlive it", async () => {
  const node = startNode();
  try {
    const wrapper = await started(node, { command: "sleep 100 & echo $!; wait" });
    await until(() => wrapper.stdout().endsWith("\n"));
    const child = Number(wrapper.stdout().trim());
    expect(alive(child)).toBe(true);

    await node.stopProcess({ processId: wrapper.processId });
    await wrapper.exit;

    await until(() => !alive(child));
  } finally { await node.shutdown(); }
});

test("when a process exits, what is left of its group is stopped, so its stream ends", async () => {
  const node = startNode();
  try {
    const wrapper = await started(node, { command: "sleep 100 & echo $!" });

    expect(await wrapper.exit).toEqual({ code: 0, signal: null });
    await until(() => !alive(Number(wrapper.stdout().trim())));
  } finally { await node.shutdown(); }
});

test("a process belongs to its stdout stream: stopping the stream (a cancel, or its connection lost) stops the process", async () => {
  const node = startNode();
  try {
    const proc = await started(node, { argv: ["sleep", "100"] });
    proc.stopStream();

    await until(() => !alive(proc.pid));
    await expect(node.writeProcess({ processId: proc.processId, data: base64("x") })).rejects.toMatchObject({ error: { code: "not_found" } });
  } finally { await node.shutdown(); }
});

test("a write is answered once the process has taken its bytes, so one that does not read holds it up", async () => {
  const node = startNode();
  try {
    const slow = await started(node, { command: "sleep 0.3; cat > /dev/null" });
    const written = Date.now();
    await node.writeProcess({ processId: slow.processId, data: Buffer.alloc(512 * 1024, 120).toString("base64") });

    expect(Date.now() - written).toBeGreaterThanOrEqual(250);
    await node.writeProcess({ processId: slow.processId, end: true });
    expect(await slow.exit).toMatchObject({ code: 0 });
  } finally { await node.shutdown(); }
});

test("a node runs at most maxProcesses at once: one more is refused until one has ended", async () => {
  const node = startNode({ maxProcesses: 2 });
  try {
    const first = await started(node, { argv: ["sleep", "100"] });
    await started(node, { argv: ["sleep", "100"] });

    await expect(started(node, { argv: ["true"] })).rejects.toMatchObject({ error: { code: "unavailable", message: "This node runs as many processes as it may (2): stop one first", retryable: true } });
    await node.stopProcess({ processId: first.processId });
    await first.exit;
    expect((await started(node, { argv: ["true"] })).pid).toBeGreaterThan(0);
  } finally { await node.shutdown(); }
});

test("a process is refused for a missing directory, a program not on PATH, an ID already running or closed input; unknown IDs are not found", async () => {
  const node = startNode();
  try {
    await expect(started(node, { argv: ["true"], cwd: "/nonexistent/reins" })).rejects.toMatchObject({ error: { code: "not_found", message: "Directory not found: /nonexistent/reins" } });
    await expect(started(node, { argv: ["no-such-program-reins"] })).rejects.toMatchObject({ error: { code: "invalid_request", message: "Program not found: no-such-program-reins" } });
    const cat = await started(node, { argv: ["cat"] });
    await expect(node.startProcess({ cwd: tmpdir(), streamId: "s", processId: cat.processId, argv: ["cat"] })).rejects.toMatchObject({ error: { code: "invalid_request" } });
    await node.writeProcess({ processId: cat.processId, end: true });
    await expect(node.writeProcess({ processId: cat.processId, data: base64("x") })).rejects.toMatchObject({ error: { code: "invalid_request", message: "The process's input is closed" } });
    for (const call of [() => node.writeProcess({ processId: "nope", end: true }), () => node.stopProcess({ processId: "nope" })]) {
      await expect(call()).rejects.toMatchObject({ error: { code: "not_found", message: "Unknown process: nope" } });
    }
  } finally { await node.shutdown(); }
});

test("shutting the node down stops its processes", async () => {
  const node = startNode();
  const proc = await started(node, { command: "sleep 100 & sleep 100" });

  await node.shutdown();

  expect(alive(proc.pid)).toBe(false);
  await expect(node.startProcess({ cwd: tmpdir(), streamId: "s", processId: "late", argv: ["true"] })).rejects.toThrow("Node stopped");
});

import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { outputParser } from "@reins/node-protocol";
import { startNode, type Node, type OpenStreamSource } from "./node.js";

const until = async (condition: () => boolean) => { for (let i = 0; i < 400 && !condition(); i++) await Bun.sleep(5); expect(condition()).toBe(true); };
const base64 = (text: string) => Buffer.from(text).toString("base64");
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Reads a process's output stream as the connection would: `stdout()` and `stderr()` are what it printed so
 * far, `output()` both in the order they came, `bytes()` how many bytes of frames came, `exit` its stream's end
 * (rejecting when the stream failed), `stopStream()` stops the stream (a cancel, or the link lost). */
function reading(source: OpenStreamSource) {
  const stream = new AbortController();
  const output: { channel: "stdout" | "stderr"; text: string }[] = [];
  let bytes = 0;
  const parser = outputParser((channel, data) => output.push({ channel, text: Buffer.from(data).toString("utf8") }));
  const exit = (async () => {
    const iterator = source(stream.signal)[Symbol.asyncIterator]();
    for (;;) {
      const step = await iterator.next();
      if (step.done) { parser.end(); return step.value || undefined; }
      const chunk = typeof step.value === "string" ? Buffer.from(step.value) : step.value;
      bytes += chunk.byteLength;
      parser.push(chunk);
    }
  })();
  exit.catch(() => undefined);
  const of = (channel: "stdout" | "stderr") => output.filter(part => part.channel === channel).map(part => part.text).join("");
  return { exit, stdout: () => of("stdout"), stderr: () => of("stderr"), output: () => output, bytes: () => bytes, stopStream: () => stream.abort() };
}

/** Starts a process on `node` and reads its output stream (`reading`). */
async function started(node: Node, input: { argv?: string[]; command?: string; env?: Record<string, string>; cwd?: string; stdin?: boolean }) {
  const processId = crypto.randomUUID();
  const { result, source } = await node.startProcess({ cwd: input.cwd ?? tmpdir(), streamId: crypto.randomUUID(), processId, ...input });
  return { processId, pid: result.pid, ...reading(source) };
}

/** Writes `text` to a process's stdin at `offset`. */
const write = (node: Node, processId: string, offset: number, text: string, end?: boolean) =>
  node.writeProcess({ processId, offset, data: base64(text), ...(end ? { end } : {}) });

test("a process reads what the server writes to its stdin, its stdout streams back, and closing its input ends it", async () => {
  const node = startNode();
  try {
    const cat = await started(node, { argv: ["cat"] });
    await write(node, cat.processId, 0, "{\"jsonrpc\":\"2.0\",\"id\":1}\n");
    await until(() => cat.stdout() === "{\"jsonrpc\":\"2.0\",\"id\":1}\n");
    await write(node, cat.processId, 25, "bye", true);

    expect(await cat.exit).toEqual({ code: 0, signal: null });
    expect(cat.stdout()).toBe("{\"jsonrpc\":\"2.0\",\"id\":1}\nbye");
    await expect(write(node, cat.processId, 28, "late")).rejects.toMatchObject({ error: { code: "not_found" } });
  } finally { await node.shutdown(); }
});

test("a process started without stdin reads nothing and takes no input", async () => {
  const node = startNode();
  try {
    const reader = await started(node, { command: "cat; echo done", stdin: false });

    expect(await reader.exit).toEqual({ code: 0, signal: null });
    expect(reader.stdout()).toBe("done\n");
    await expect(node.writeProcess({ processId: reader.processId, offset: 0, end: true })).rejects.toMatchObject({ error: { code: "not_found" } });
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
    await write(node, proc.processId, 0, "no token\n");

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

test("a process outlives its stream: attaching again from an offset gets its output from there, and stops the stream still open", async () => {
  const node = startNode();
  try {
    const proc = await started(node, { command: "echo one; read go; echo two >&2; read go; echo three" });
    await until(() => proc.stdout() === "one\n");
    const taken = proc.bytes();
    proc.stopStream();
    await write(node, proc.processId, 0, "go\n");
    await Bun.sleep(50);

    const { result, source } = await node.attachProcess({ streamId: "s2", processId: proc.processId, offset: taken });
    const again = reading(source);
    await until(() => again.stderr() === "two\n");
    const { source: third } = await node.attachProcess({ streamId: "s3", processId: proc.processId, offset: taken });
    const last = reading(third);
    await write(node, proc.processId, 3, "go\n");

    expect(result).toEqual({ pid: proc.pid, offset: taken, lost: 0, input: 3 });
    expect(await last.exit).toEqual({ code: 0, signal: null });
    expect(last.output()).toEqual([{ channel: "stderr", text: "two\n" }, { channel: "stdout", text: "three\n" }]);
    await expect(again.exit).rejects.toThrow("Another stream attached to this output");
    // Its exit is kept for the grace period, for a server that missed it.
    const { result: afterExit, source: ended } = await node.attachProcess({ streamId: "s4", processId: proc.processId, offset: taken });
    expect(afterExit.lost).toBeGreaterThan(0);
    expect(await reading(ended).exit).toEqual({ code: 0, signal: null });
  } finally { await node.shutdown(); }
});

test("output older than the kept tail is gone: attaching from before it starts at the oldest frame kept, saying how many bytes were lost", async () => {
  const node = startNode({ processTailBytes: 1024 });
  try {
    const proc = await started(node, { command: "for i in 1 2 3 4 5 6; do head -c 400 /dev/zero | tr '\\0' $i; sleep 0.02; done; read go" });
    proc.stopStream();
    await Bun.sleep(300);

    const { result, source } = await node.attachProcess({ streamId: "s2", processId: proc.processId, offset: 0 });
    const resumed = reading(source);
    await until(() => resumed.stdout().endsWith("6".repeat(400)));

    expect(result.lost).toBe(result.offset);
    expect(result.lost).toBeGreaterThanOrEqual(3 * 405);
    expect(resumed.stdout().startsWith("1")).toBe(false);
    expect(resumed.bytes()).toBeLessThanOrEqual(1024 + 405);
    await expect(node.attachProcess({ streamId: "s3", processId: proc.processId, offset: result.offset + 1 })).rejects.toMatchObject({ error: { code: "invalid_request" } });
  } finally { await node.shutdown(); }
});

test("a process nobody attaches to within the grace period is stopped and forgotten", async () => {
  const node = startNode({ processGraceMs: 100 });
  try {
    const proc = await started(node, { command: "sleep 100 & sleep 100" });
    proc.stopStream();
    await Bun.sleep(30);
    expect(alive(proc.pid)).toBe(true);

    await until(() => !alive(proc.pid));
    await Bun.sleep(50);
    await expect(node.attachProcess({ streamId: "s2", processId: proc.processId, offset: 0 })).rejects.toMatchObject({ error: { code: "not_found" } });
  } finally { await node.shutdown(); }
});

test("a write sent again at its offset is not taken twice; one past what the process was given is refused", async () => {
  const node = startNode();
  try {
    const cat = await started(node, { argv: ["cat"] });
    await write(node, cat.processId, 0, "abc");
    await write(node, cat.processId, 0, "abc");
    await write(node, cat.processId, 1, "bcde");
    await expect(write(node, cat.processId, 9, "x")).rejects.toMatchObject({ error: { code: "invalid_request" } });
    await node.writeProcess({ processId: cat.processId, offset: 5, end: true });
    await node.writeProcess({ processId: cat.processId, offset: 5, end: true });

    expect(await cat.exit).toEqual({ code: 0, signal: null });
    expect(cat.stdout()).toBe("abcde");
  } finally { await node.shutdown(); }
});

test("a write is answered once the process has taken its bytes, so one that does not read holds it up", async () => {
  const node = startNode();
  try {
    const slow = await started(node, { command: "sleep 0.3; cat > /dev/null" });
    const written = Date.now();
    await node.writeProcess({ processId: slow.processId, offset: 0, data: Buffer.alloc(512 * 1024, 120).toString("base64") });

    expect(Date.now() - written).toBeGreaterThanOrEqual(250);
    await node.writeProcess({ processId: slow.processId, offset: 512 * 1024, end: true });
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
    await node.writeProcess({ processId: cat.processId, offset: 0, end: true });
    await expect(write(node, cat.processId, 0, "x")).rejects.toMatchObject({ error: { code: "invalid_request", message: "The process's input is closed" } });
    for (const call of [() => node.writeProcess({ processId: "nope", offset: 0, end: true }), () => node.stopProcess({ processId: "nope" }), () => node.attachProcess({ streamId: "s", processId: "nope", offset: 0 })]) {
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

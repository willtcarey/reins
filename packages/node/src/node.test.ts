import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startNode, type Node, type OpenStreamSource } from "./node.js";

const until = async (condition: () => boolean) => { for (let i = 0; i < 200 && !condition(); i++) await Bun.sleep(5); expect(condition()).toBe(true); };

test("reload is refused when nothing would restart the node or its new code does not build; otherwise it answers at once and restarts", async () => {
  const unsupervised = startNode();
  const broken = startNode({ reload: { check: async () => { throw new Error("Unexpected token in node.ts"); }, restart: () => { throw new Error("must not restart"); } } });
  let restarts = 0;
  const node = startNode({ reload: { check: async () => {}, restart: () => { restarts++; } } });
  try {
    await expect(unsupervised.reload({})).rejects.toMatchObject({ error: { code: "unavailable", retryable: false } });
    await expect(broken.reload({})).rejects.toMatchObject({ error: { code: "invalid_request", message: "The node's new code does not build: Unexpected token in node.ts" } });

    expect(await node.reload({})).toEqual({ scheduled: true });
    // A second request joins the pending reload.
    expect(await node.reload({})).toEqual({ scheduled: true });
    await until(() => restarts === 1);
    await Bun.sleep(30);
    expect(restarts).toBe(1);
  } finally { await unsupervised.shutdown(); await broken.shutdown(); await node.shutdown(); }
});

/** Starts a command on the node's tool host (`env.exec`) and reads its output stream as the server does:
 * `exit` resolves with the command's exit record. The command waits for `release()` to finish. */
async function gatedExec(node: Node, cwd: string) {
  const execId = crypto.randomUUID();
  const released = join(cwd, `${execId}.released`);
  const command = `while [ ! -e ${released} ]; do sleep 0.01; done; echo done`;
  const source = await node.envExec({ sourceId: 7, cwd, streamId: crypto.randomUUID(), execId, command, options: {} });
  const exit = (async () => {
    const records: Array<{ exit?: unknown }> = [];
    for await (const line of source(new AbortController().signal)) records.push(JSON.parse(String(line)));
    return records.find(record => "exit" in record)?.exit;
  })();
  let exited = false;
  void exit.finally(() => { exited = true; });
  return { execId, command, exit, exited: () => exited, release: () => writeFileSync(released, "") };
}
const startExec = (node: Node, cwd: string) => node.envExec({ sourceId: 7, cwd, streamId: crypto.randomUUID(), execId: crypto.randomUUID(), command: "true", options: {} });

test("a reload waits for the commands its tool host runs and restarts once the last has exited and its output was read; meanwhile it refuses new commands as unavailable", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "reins-node-drain-"));
  let restarts = 0;
  const node = startNode({ reload: { check: async () => {}, restart: () => { restarts++; } } });
  try {
    const running = await gatedExec(node, cwd);
    expect(await node.reload({})).toEqual({ scheduled: true });
    await Bun.sleep(50);
    expect(restarts).toBe(0);
    // Refused, not held: a command started now would hold the reload up in turn.
    await expect(startExec(node, cwd)).rejects.toMatchObject({ error: { code: "unavailable", retryable: true } });

    running.release();
    expect(await running.exit).toMatchObject({ ok: true, value: { exitCode: 0 } });
    await until(() => restarts === 1);
  } finally { await node.shutdown(); rmSync(cwd, { recursive: true, force: true }); }
});

test("a pause still waiting for a command at its timeout names it; without force the reload is cancelled and the command runs on, with force the reload goes ahead and shutting down kills it", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "reins-node-drain-"));
  let restarts = 0;
  const node = startNode({ reload: { check: async () => {}, restart: () => { restarts++; }, drainTimeoutMs: 30 } });
  try {
    const running = await gatedExec(node, cwd);
    expect(await node.pause({ timeoutMs: 30 })).toEqual({ paused: false, blocking: [`exec ${running.execId}: ${running.command.slice(0, 100)}`] });

    expect(await node.reload({})).toEqual({ scheduled: true });
    await Bun.sleep(100);
    expect(restarts).toBe(0);
    expect(running.exited()).toBe(false);
    // Cancelled: commands are accepted again.
    await startExec(node, cwd);

    expect(await node.reload({ force: true })).toEqual({ scheduled: true });
    await until(() => restarts === 1);
    expect(running.exited()).toBe(false);
    await node.shutdown();
    expect(await running.exit).toMatchObject({ ok: false, error: { code: "aborted" } });
  } finally { await node.shutdown(); rmSync(cwd, { recursive: true, force: true }); }
});

test("checkout.environment serves the checkout's context files (its own and its ancestors', root first) and skills with content, and the node's docs, never the node's ~/.agents", async () => {
  const root = mkdtempSync(join(tmpdir(), "reins-node-environment-"));
  const home = join(root, "home");
  const cwd = join(root, "workspace", "project");
  const write = (path: string, content: string) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, content); };
  write(join(home, ".agents", "AGENTS.md"), "the node's own instructions");
  write(join(home, ".agents", "skills", "mine", "SKILL.md"), "---\nname: mine\ndescription: The node's own\n---\n");
  write(join(root, "workspace", "AGENTS.md"), "workspace instructions");
  write(join(cwd, "AGENTS.md"), "project instructions");
  const review = "---\nname: review\ndescription: Reviews code\ndisable-model-invocation: true\n---\n\nRead the diff.";
  write(join(cwd, ".agents", "skills", "review", "SKILL.md"), review);
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const node = startNode();
  try {
    const environment = await node.checkoutEnvironment({ sourceId: 7, cwd });
    expect(environment.contextFiles.filter(file => file.path.startsWith(root))).toEqual([
      { path: join(root, "workspace", "AGENTS.md"), content: "workspace instructions" },
      { path: join(cwd, "AGENTS.md"), content: "project instructions" },
    ]);
    expect(environment.contextFiles.some(file => file.path.startsWith(home))).toBe(false);
    expect(environment.skills).toEqual([
      { name: "review", description: "Reviews code", path: join(cwd, ".agents", "skills", "review", "SKILL.md"), content: review, disableModelInvocation: true },
    ]);
    // This checkout's docs/, as the environment prompt names them.
    expect(environment.docs).toEqual({ dir: process.env.REINS_DOCS_DIR || join(import.meta.dir, "../../../docs"), devDocs: true });
    await expect(node.checkoutEnvironment({ sourceId: 7, cwd: join(cwd, "missing") })).rejects.toMatchObject({ error: { code: "not_found" } });
  } finally {
    process.env.HOME = previousHome;
    await node.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

/** Runs a process stream's source to its end: its output and the exit it returned. */
async function drain(source: OpenStreamSource, signal = new AbortController().signal) {
  const iterator = source(signal)[Symbol.asyncIterator]();
  const output: Uint8Array[] = [];
  for (let next = await iterator.next(); ; next = await iterator.next()) {
    if (next.done) return { output: Buffer.concat(output).toString("utf8"), exit: next.value || undefined };
    output.push(typeof next.value === "string" ? Buffer.from(next.value) : next.value);
  }
}

test("process.run runs argv without a shell in the source checkout, merging env over the node's, and returns the exit with stderr", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "reins-node-process-"));
  const node = startNode();
  try {
    const literal = await drain(await node.runProcess({ sourceId: 7, cwd, streamId: "s1", argv: ["printf", "%s", "$HOME"] }));
    expect(literal).toEqual({ output: "$HOME", exit: { code: 0, signal: null, stderr: "" } });
    const script = 'printf "%s|%s" "$(pwd -P)" "$GREETING"; echo "bad things" >&2; exit 3';
    expect(await drain(await node.runProcess({ sourceId: 7, cwd, streamId: "s2", argv: ["sh", "-c", script], env: { GREETING: "hi" } })))
      .toEqual({ output: `${realpathSync(cwd)}|hi`, exit: { code: 3, signal: null, stderr: "bad things\n" } });
    await expect(node.runProcess({ sourceId: 7, cwd: join(cwd, "missing"), streamId: "s3", argv: ["true"] })).rejects.toMatchObject({ error: { code: "not_found" } });
    await expect(node.runProcess({ sourceId: 7, cwd, streamId: "s4", argv: ["no-such-program-reins"] })).rejects.toMatchObject({ error: { code: "invalid_request", message: "Program not found: no-such-program-reins" } });
  } finally { await node.shutdown(); rmSync(cwd, { recursive: true, force: true }); }
});

test("process.run kills its process when its stream is stopped", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "reins-node-process-"));
  const node = startNode();
  try {
    const source = await node.runProcess({ sourceId: 7, cwd, streamId: "s1", argv: ["sh", "-c", "echo $$; exec sleep 30"] });
    const stop = new AbortController();
    const iterator = source(stop.signal)[Symbol.asyncIterator]();
    const first = await iterator.next();
    const pid = first.value instanceof Uint8Array ? Number(Buffer.from(first.value).toString().trim()) : NaN;
    stop.abort();
    await iterator.return?.();
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (let i = 0; i < 100 && alive(); i++) await Bun.sleep(5);
    expect(alive()).toBe(false);
  } finally { await node.shutdown(); rmSync(cwd, { recursive: true, force: true }); }
});

test("fs.list lists one directory of the checkout, directories first then by name, without symlinks; it refuses paths outside the checkout", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "reins-node-fs-"));
  const node = startNode();
  try {
    mkdirSync(join(cwd, "src", "lib"), { recursive: true });
    writeFileSync(join(cwd, "src", "b.ts"), "");
    writeFileSync(join(cwd, "src", "A.ts"), "");
    mkdirSync(join(cwd, "src", "assets"));
    symlinkSync(join(cwd, "src", "b.ts"), join(cwd, "src", "link.ts"));
    expect(await node.listDirectory({ sourceId: 7, cwd, path: "src" })).toEqual({ entries: [
      { name: "assets", type: "directory" }, { name: "lib", type: "directory" }, { name: "A.ts", type: "file" }, { name: "b.ts", type: "file" },
    ] });
    expect((await node.listDirectory({ sourceId: 7, cwd, path: "." })).entries).toEqual([{ name: "src", type: "directory" }]);
    await expect(node.listDirectory({ sourceId: 7, cwd, path: "../.." })).rejects.toMatchObject({ error: { code: "invalid_request", message: "Path traversal not allowed" } });
    await expect(node.listDirectory({ sourceId: 7, cwd, path: "/etc" })).rejects.toMatchObject({ error: { code: "invalid_request" } });
    await expect(node.listDirectory({ sourceId: 7, cwd, path: "missing" })).rejects.toMatchObject({ error: { code: "not_found", message: "Directory not found" } });
  } finally { await node.shutdown(); rmSync(cwd, { recursive: true, force: true }); }
});

test("fs.write keeps a file's chunks in the node's data directory, in order, and puts the file in place with the last; it refuses gaps and paths outside the checkout", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "reins-node-fs-"));
  const dataDir = mkdtempSync(join(tmpdir(), "reins-node-data-"));
  const node = startNode({ dataDir });
  const chunk = (path: string, offset: number, text: string, last: boolean) =>
    node.writeFile({ sourceId: 7, cwd, path, offset, data: Buffer.from(text).toString("base64"), last });
  try {
    expect(await chunk("docs/new/notes.txt", 0, "hello ", false)).toEqual({ size: 6 });
    // Nothing in the checkout until the last chunk: not the file, not its directories.
    expect(readdirSync(cwd)).toEqual([]);
    expect(readdirSync(join(dataDir, "partial-writes"))).toHaveLength(1);
    await expect(chunk("docs/new/notes.txt", 3, "late", false)).rejects.toMatchObject({ error: { code: "invalid_request", message: "Chunk out of order: 6 bytes written, chunk at 3" } });
    expect(await chunk("docs/new/notes.txt", 6, "world", true)).toEqual({ size: 11 });
    expect(readFileSync(join(cwd, "docs", "new", "notes.txt"), "utf8")).toBe("hello world");
    expect(readdirSync(join(dataDir, "partial-writes"))).toEqual([]);

    // A later upload replaces it.
    await chunk("docs/new/notes.txt", 0, "again", true);
    expect(readFileSync(join(cwd, "docs", "new", "notes.txt"), "utf8")).toBe("again");

    await expect(chunk("../outside.txt", 0, "x", true)).rejects.toMatchObject({ error: { code: "invalid_request", message: "Path traversal not allowed" } });
    await expect(chunk("docs", 0, "x", true)).rejects.toMatchObject({ error: { code: "invalid_request", message: "Not a file path: docs" } });
    await expect(chunk("docs/new/notes.txt/inner", 0, "x", true)).rejects.toMatchObject({ error: { code: "invalid_request" } });
  } finally { await node.shutdown(); rmSync(cwd, { recursive: true, force: true }); rmSync(dataDir, { recursive: true, force: true }); }
});

test("a node starting on a data directory removes the writes a previous run left unfinished", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "reins-node-fs-"));
  const dataDir = mkdtempSync(join(tmpdir(), "reins-node-data-"));
  const write = (node: ReturnType<typeof startNode>, offset: number) =>
    node.writeFile({ sourceId: 7, cwd, path: "upload.bin", offset, data: Buffer.from("abc").toString("base64"), last: false });
  try {
    const first = startNode({ dataDir });
    await write(first, 0);
    await first.shutdown();
    expect(readdirSync(join(dataDir, "partial-writes"))).toHaveLength(1);

    const second = startNode({ dataDir });
    expect(existsSync(join(dataDir, "partial-writes"))).toBe(false);
    // The interrupted write cannot continue: its bytes are gone.
    await expect(write(second, 3)).rejects.toMatchObject({ error: { code: "invalid_request", message: "Chunk out of order: 0 bytes written, chunk at 3" } });
    await second.shutdown();
  } finally { rmSync(cwd, { recursive: true, force: true }); rmSync(dataDir, { recursive: true, force: true }); }
});

/** A binary stream's source read to its end. */
async function readSource(source: OpenStreamSource): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of source(new AbortController().signal)) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return new Uint8Array(Buffer.concat(chunks));
}

test("fs.read answers a file's size and streams its exact bytes, or the first maxBytes; it refuses anything but a file inside the checkout", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "reins-node-fs-"));
  const node = startNode();
  try {
    mkdirSync(join(cwd, "src"));
    // Large enough that a sliced Bun file stream would never end (see `readFile`).
    const content = new Uint8Array(2 * 1024 * 1024).map((_, i) => (i * 7) % 256);
    writeFileSync(join(cwd, "src", "data.bin"), content);

    const whole = await node.readFile({ sourceId: 7, cwd, streamId: "s1", path: "src/data.bin" });
    expect(whole.size).toBe(content.length);
    expect(await readSource(whole.source)).toEqual(content);
    const prefix = await node.readFile({ sourceId: 7, cwd, streamId: "s2", path: "src/data.bin", maxBytes: 10 });
    expect(prefix.size).toBe(content.length);
    expect(await readSource(prefix.source)).toEqual(content.slice(0, 10));

    await expect(node.readFile({ sourceId: 7, cwd, streamId: "s3", path: "src" })).rejects.toMatchObject({ error: { code: "not_found", message: "File not found" } });
    await expect(node.readFile({ sourceId: 7, cwd, streamId: "s4", path: "missing.txt" })).rejects.toMatchObject({ error: { code: "not_found" } });
    await expect(node.readFile({ sourceId: 7, cwd, streamId: "s5", path: "../outside" })).rejects.toMatchObject({ error: { code: "invalid_request", message: "Path traversal not allowed" } });
  } finally { await node.shutdown(); rmSync(cwd, { recursive: true, force: true }); }
});

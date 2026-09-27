import { test, expect } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NdjsonSocket } from "@reins/node/protocol";
import { listenLocalNodeSocket } from "../../node-transport/local-socket.js";

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "reins-sock-"));
  return { dir, [Symbol.dispose]: () => rmSync(dir, { recursive: true, force: true }) };
}
const connect = (path: string) => Bun.connect({ unix: path, socket: { data() {} } });

test("creates a private directory and a 0600 socket, accepts NDJSON connections, and removes the socket on stop", async () => {
  using temp = tempDir();
  const path = join(temp.dir, "run", "node.sock");
  const accepted: NdjsonSocket[] = [];
  const listener = await listenLocalNodeSocket(path, socket => {
    accepted.push(socket);
    socket.onmessage = data => socket.send(data);
  });
  try {
    expect(statSync(join(temp.dir, "run")).mode & 0o777).toBe(0o700);
    expect(lstatSync(path).isSocket()).toBe(true);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    const replies: string[] = [];
    const client = await Bun.connect({ unix: path, socket: { data(_socket, chunk) { replies.push(chunk.toString()); } } });
    client.write('{"ping":1}\n');
    for (let i = 0; i < 100 && replies.join("") !== '{"ping":1}\n'; i++) await Bun.sleep(5);
    expect(replies.join("")).toBe('{"ping":1}\n');
    expect(accepted).toHaveLength(1);
  } finally { listener.stop(); }
  expect(existsSync(path)).toBe(false);
  expect(accepted[0]!.closed).toBe(true);
  await expect(connect(path)).rejects.toThrow();
});

test("replaces a stale socket nobody accepts on, and fails clearly while another listener is live", async () => {
  using temp = tempDir();
  const path = join(temp.dir, "node.sock");
  // A socket file left by a process that exited without cleanup: Bun leaves the file and nothing accepts on it.
  Bun.listen({ unix: path, socket: { data() {} } }).stop(true);
  expect(lstatSync(path).isSocket()).toBe(true);
  await expect(connect(path)).rejects.toThrow();
  const listener = await listenLocalNodeSocket(path, () => {});
  try {
    (await connect(path)).end();
    await expect(listenLocalNodeSocket(path, () => {})).rejects.toThrow(`Another process is already listening on the node socket: ${path}`);
    // The failed attempt left the live socket alone.
    (await connect(path)).end();
  } finally { listener.stop(); }
});

test("refuses a path that is not a socket, a relative or overlong path, and a directory others can write", async () => {
  using temp = tempDir();
  const file = join(temp.dir, "file");
  writeFileSync(file, "keep");
  await expect(listenLocalNodeSocket(file, () => {})).rejects.toThrow(`Node socket path exists and is not a socket: ${file}`);
  expect(existsSync(file)).toBe(true);
  await expect(listenLocalNodeSocket("run/node.sock", () => {})).rejects.toThrow("must be absolute");
  await expect(listenLocalNodeSocket(join(temp.dir, "x".repeat(120)), () => {})).rejects.toThrow("longer than 103 bytes");
  const shared = join(temp.dir, "shared");
  mkdirSync(shared);
  chmodSync(shared, 0o777);
  await expect(listenLocalNodeSocket(join(shared, "node.sock"), () => {})).rejects.toThrow("writable by other users");
});

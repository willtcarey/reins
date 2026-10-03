import { test, expect } from "bun:test";
import { z } from "zod";
import { createNodeConnection, helloParams, MAX_LIVE_SESSIONS, protocolVersion, readyResult } from "./node-connection.js";
import { createRpcPeer } from "./rpc.js";
import { STREAM_CHUNK_BYTES } from "./fields.js";
import { createLoopbackPair, scriptedCommandHandlers } from "./testing.js";

test("version ranges and capabilities are validated at the wire boundary", () => {
  expect(helloParams.safeParse({ minVersion: 3, maxVersion: 1, nodeId: "n", capabilities: ["session.prompt"], liveSessions: [] }).success).toBe(false);
  expect(helloParams.safeParse({ minVersion: 1, maxVersion: 2, nodeId: "n", capabilities: ["session.prompt", "future.optional"], liveSessions: [] }).success).toBe(true);
  // Crash recovery: the node lists the sessions it has a run in progress for, bounded.
  expect(helloParams.safeParse({ minVersion: 1, maxVersion: 2, nodeId: "n", capabilities: [], liveSessions: ["s1", "s2"] }).success).toBe(true);
  expect(helloParams.safeParse({ minVersion: 1, maxVersion: 2, nodeId: "n", capabilities: [] }).success).toBe(false);
  expect(helloParams.safeParse({ minVersion: 1, maxVersion: 2, nodeId: "n", capabilities: [], liveSessions: Array.from({ length: MAX_LIVE_SESSIONS + 1 }, (_, i) => `s${i}`) }).success).toBe(false);
  expect(readyResult.safeParse({ version: protocolVersion + 1, capabilities: ["session.prompt"], epoch: crypto.randomUUID() }).success).toBe(false);
  expect(readyResult.safeParse({ version: protocolVersion, capabilities: ["arbitrary.command"], epoch: crypto.randomUUID() }).success).toBe(false);
});

interface Frame { method: string; params: { streamId: string; offset?: number; data?: string; error?: string } }

/** A negotiated node connection over the loopback whose server end records the stream frames it
 * receives. `hold()` makes the node's socket report unwritten bytes until `release()`, like a socket
 * whose kernel buffer is full. */
async function streamingNode() {
  const [serverEnd, nodeEnd] = createLoopbackPair();
  const epoch = crypto.randomUUID();
  const frames: Frame[] = [];
  const record = (method: string) => ({ params: z.any(), notify: ({ epoch: _, ...params }: Frame["params"] & { epoch: string }) => { frames.push({ method, params }); } });
  const server = createRpcPeer(serverEnd, {
    "node.hello": { params: z.unknown(), result: z.unknown(), handle: async () => ({ version: protocolVersion, capabilities: ["stream.cancel"], epoch }) },
    "stream.data": record("stream.data"), "stream.end": record("stream.end"),
  });
  serverEnd.onmessage = server.receive;
  let held: PromiseWithResolvers<void> | undefined;
  const connection = createNodeConnection({ send: data => nodeEnd.send(data), close: () => nodeEnd.close(), drained: () => held?.promise ?? Promise.resolve() }, {
    nodeId: "n", minVersion: protocolVersion, maxVersion: protocolVersion, capabilities: ["stream.cancel"], liveSessions: [], ...scriptedCommandHandlers({}),
  });
  nodeEnd.onmessage = connection.receive;
  await connection.ready;
  return {
    connection, frames,
    data: () => frames.filter(frame => frame.method === "stream.data").map(frame => frame.params),
    cancel: (streamId: string) => server.notify("stream.cancel", { epoch, streamId }),
    hold() { held = Promise.withResolvers(); },
    release() { held?.resolve(); held = undefined; },
  };
}

const until = async (done: () => boolean) => { for (let i = 0; i < 200 && !done(); i++) await Bun.sleep(1); expect(done()).toBe(true); };

test("a stream crosses as chunks of at most STREAM_CHUNK_BYTES, each at its absolute UTF-8 byte offset, then ends", async () => {
  const node = await streamingNode();
  const euro = new TextEncoder().encode("€");
  // A large binary item with multi-byte characters straddling chunk boundaries, and a character split across items.
  const large = new TextEncoder().encode("€".repeat(STREAM_CHUNK_BYTES));
  const text = `héllo ${"€".repeat(STREAM_CHUNK_BYTES)}€!`;
  await node.connection.stream("s1", async function* () {
    yield "héllo ";
    yield large;
    yield euro.subarray(0, 1);
    yield euro.subarray(1);
    yield "!";
  });
  const chunks = node.data();
  expect(chunks.map(chunk => chunk.data).join("")).toBe(text);
  let offset = 0;
  for (const chunk of chunks) {
    expect(chunk).toMatchObject({ streamId: "s1", offset });
    offset += Buffer.byteLength(chunk.data!);
    expect(Buffer.byteLength(chunk.data!)).toBeLessThanOrEqual(STREAM_CHUNK_BYTES + 3);
  }
  expect(offset).toBe(Buffer.byteLength(text));
  expect(node.frames.at(-1)).toEqual({ method: "stream.end", params: { streamId: "s1" } });
});

test("the next chunk is sent only once the socket has drained", async () => {
  const node = await streamingNode();
  node.hold();
  const done = node.connection.stream("s1", async function* () { yield "a"; yield "b"; yield "c"; });
  await until(() => node.data().length === 1);
  await Bun.sleep(10);
  expect(node.data().map(chunk => chunk.data)).toEqual(["a"]);
  node.release();
  await done;
  expect(node.data().map(chunk => chunk.data)).toEqual(["a", "b", "c"]);
});

test("stream.cancel stops the producer and nothing more is sent for the stream", async () => {
  const node = await streamingNode();
  let signal: AbortSignal | undefined;
  let stopped = false;
  const done = node.connection.stream("s1", async function* (abort) {
    signal = abort;
    try { for (let i = 0; ; i++) { yield `chunk ${i}`; await Bun.sleep(1); } } finally { stopped = true; }
  });
  await until(() => node.data().length >= 2);
  node.cancel("s1");
  await done;
  expect(signal?.aborted).toBe(true);
  expect(stopped).toBe(true);
  const sent = node.frames.length;
  await Bun.sleep(10);
  expect(node.frames).toHaveLength(sent);
  expect(node.frames.some(frame => frame.method === "stream.end")).toBe(false);
});

test("a failing source ends its stream with the error, and a stream ID cannot be served twice at once", async () => {
  const node = await streamingNode();
  const open = Promise.withResolvers<void>();
  const running = node.connection.stream("s1", async function* () { yield "partial"; await open.promise; throw new Error("git exited with 128"); });
  expect(() => node.connection.stream("s1", async function* () { yield "again"; })).toThrow("Stream s1 is already open");
  open.resolve();
  await running;
  expect(node.frames).toEqual([
    { method: "stream.data", params: { streamId: "s1", offset: 0, data: "partial" } },
    { method: "stream.end", params: { streamId: "s1", error: "git exited with 128" } },
  ]);
});

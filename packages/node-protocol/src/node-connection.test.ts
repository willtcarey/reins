import { test, expect } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { z } from "zod";
import { createNodeConnection, helloParams, MAX_LIVE_SESSIONS, methods, protocolVersion, readyResult, type Hello } from "./node-connection.js";
import { authenticateResult, newNodeChallenge, verifyNodeAnswer } from "./node-auth.js";
import { createRpcPeer, UNAUTHORIZED } from "./rpc.js";
import { STREAM_CHUNK_BYTES } from "./fields.js";
import { createLoopbackPair, scriptedCommandHandlers } from "./testing.js";
import type { OpenStreamSource } from "./streams.js";

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

interface Frame { method: string; params: { streamId: string; offset?: number; data?: string; encoding?: string; error?: string; exit?: unknown } }

const until = async (done: () => boolean) => { for (let i = 0; i < 200 && !done(); i++) await Bun.sleep(1); expect(done()).toBe(true); };

/** A negotiated node connection over the loopback whose server end opens streams with `process.run`
 * (the node serves the source a test gives it) and records the stream frames it receives. `hold()` makes
 * the node's socket report unwritten bytes until `release()`, like a socket whose kernel buffer is full. */
async function streamingNode() {
  const [serverEnd, nodeEnd] = createLoopbackPair();
  const epoch = crypto.randomUUID();
  const capabilities = ["stream.cancel", "process.run"];
  const frames: Frame[] = [];
  const record = (method: string) => ({ params: z.any(), notify: ({ epoch: _, ...params }: Frame["params"] & { epoch: string }) => { frames.push({ method, params }); } });
  const server = createRpcPeer(serverEnd, {
    "node.hello": { params: z.unknown(), result: z.unknown(), handle: async () => ({ version: protocolVersion, capabilities, epoch }) },
    "stream.data": record("stream.data"), "stream.end": record("stream.end"),
  });
  serverEnd.onmessage = server.receive;
  let held: PromiseWithResolvers<void> | undefined;
  const sources: OpenStreamSource[] = [];
  const connection = createNodeConnection({ send: data => nodeEnd.send(data), close: () => nodeEnd.close(), drained: () => held?.promise ?? Promise.resolve() }, {
    nodeId: "n", minVersion: protocolVersion, maxVersion: protocolVersion, capabilities, liveSessions: [],
    ...scriptedCommandHandlers({ runProcess: async () => sources.shift()! }),
  });
  nodeEnd.onmessage = connection.receive;
  await connection.ready;
  return {
    frames,
    data: () => frames.filter(frame => frame.method === "stream.data").map(frame => frame.params),
    /** Opens stream `streamId` with `process.run`, served from `source`; resolves with the node's reply. */
    open(streamId: string, source: OpenStreamSource, { binary = false }: { binary?: boolean } = {}) {
      sources.push(source);
      return server.call("process.run", { epoch, sourceId: 1, cwd: "/checkout", streamId, argv: ["producer"], ...(binary ? { binary } : {}) }, z.unknown());
    },
    ended: (streamId: string) => until(() => frames.some(frame => frame.method === "stream.end" && frame.params.streamId === streamId)),
    cancel: (streamId: string) => server.notify("stream.cancel", { epoch, streamId }),
    hold() { held = Promise.withResolvers(); },
    release() { held?.resolve(); held = undefined; },
  };
}

test("a stream crosses as chunks of at most STREAM_CHUNK_BYTES, each at its absolute UTF-8 byte offset, then ends", async () => {
  const node = await streamingNode();
  const euro = new TextEncoder().encode("€");
  // A large binary item with multi-byte characters straddling chunk boundaries, and a character split across items.
  const large = new TextEncoder().encode("€".repeat(STREAM_CHUNK_BYTES));
  const text = `héllo ${"€".repeat(STREAM_CHUNK_BYTES)}€!`;
  expect(await node.open("s1", async function* () {
    yield "héllo ";
    yield large;
    yield euro.subarray(0, 1);
    yield euro.subarray(1);
    yield "!";
  })).toEqual({});
  await node.ended("s1");
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
  await node.open("s1", async function* () { yield "a"; yield "b"; yield "c"; });
  await until(() => node.data().length === 1);
  await Bun.sleep(10);
  expect(node.data().map(chunk => chunk.data)).toEqual(["a"]);
  node.release();
  await node.ended("s1");
  expect(node.data().map(chunk => chunk.data)).toEqual(["a", "b", "c"]);
});

test("stream.cancel stops the producer and nothing more is sent for the stream", async () => {
  const node = await streamingNode();
  let signal: AbortSignal | undefined;
  let stopped = false;
  await node.open("s1", async function* (abort) {
    signal = abort;
    try { for (let i = 0; ; i++) { yield `chunk ${i}`; await Bun.sleep(1); } } finally { stopped = true; }
  });
  await until(() => node.data().length >= 2);
  node.cancel("s1");
  await until(() => stopped);
  expect(signal?.aborted).toBe(true);
  expect(stopped).toBe(true);
  const sent = node.frames.length;
  await Bun.sleep(10);
  expect(node.frames).toHaveLength(sent);
  expect(node.frames.some(frame => frame.method === "stream.end")).toBe(false);
});

test("what a source returns when it finishes (a process's exit) crosses in the stream's end frame", async () => {
  const node = await streamingNode();
  const exit = { code: 1, signal: null, stderr: "fatal: not a git repository\n" };
  await node.open("s1", async function* () { yield "out"; return exit; });
  await node.ended("s1");
  expect(node.frames.at(-1)).toEqual({ method: "stream.end", params: { streamId: "s1", exit } });
});

test("a binary stream crosses as base64 chunks whose offsets count the raw bytes", async () => {
  const node = await streamingNode();
  const bytes = new Uint8Array(STREAM_CHUNK_BYTES + 10).map((_, i) => i % 256);
  await node.open("s1", async function* () { yield bytes.subarray(0, 5); yield bytes.subarray(5); }, { binary: true });
  await node.ended("s1");
  const chunks = node.data();
  expect(chunks.map(chunk => [chunk.offset, chunk.encoding])).toEqual([[0, "base64"], [5, "base64"], [5 + STREAM_CHUNK_BYTES, "base64"]]);
  expect(Buffer.concat(chunks.map(chunk => Buffer.from(chunk.data!, "base64")))).toEqual(Buffer.from(bytes));
});

test("a failing source ends its stream with the error, and a stream ID cannot be opened twice at once", async () => {
  const node = await streamingNode();
  const open = Promise.withResolvers<void>();
  await node.open("s1", async function* () { yield "partial"; await open.promise; throw new Error("git exited with 128"); });
  await expect(node.open("s1", async function* () { yield "again"; })).rejects.toThrow();
  open.resolve();
  await node.ended("s1");
  expect(node.frames).toEqual([
    { method: "stream.data", params: { streamId: "s1", offset: 0, data: "partial" } },
    { method: "stream.end", params: { streamId: "s1", error: "git exited with 128" } },
  ]);
});

test("a node with an identity answers the server's challenge, then says hello for that node and negotiates", async () => {
  const [serverEnd, nodeEnd] = createLoopbackPair();
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const origin = "https://reins.example.test";
  const epoch = crypto.randomUUID();
  const order: string[] = [];
  const server = createRpcPeer(serverEnd, {
    "node.hello": { params: helloParams, result: readyResult, handle: async (hello: Hello) => { order.push(`hello ${hello.nodeId}`); return { version: protocolVersion, capabilities: [], epoch }; } },
  });
  serverEnd.onmessage = server.receive;
  const connection = createNodeConnection(nodeEnd, {
    nodeId: "node-a", minVersion: protocolVersion, maxVersion: protocolVersion, capabilities: [], liveSessions: [],
    identity: { nodeId: "node-a", origin, privateKey }, ...scriptedCommandHandlers({}),
  });
  nodeEnd.onmessage = connection.receive;
  // The server speaks first; nothing reaches it before its challenge is answered.
  await Bun.sleep(5);
  expect(order).toEqual([]);
  const challenge = newNodeChallenge();
  const answer = await server.call(methods.nodeAuthenticate, challenge, authenticateResult);
  order.push("answer");
  expect(verifyNodeAnswer({ publicKey: publicKey.export({ format: "jwk" }).x!, origin, challenge, answer })).toBe(true);
  expect((await connection.ready).epoch).toBe(epoch);
  expect(order).toEqual(["answer", "hello node-a"]);
  // One challenge per connection: the node answers no other.
  await expect(server.call(methods.nodeAuthenticate, newNodeChallenge(), authenticateResult)).rejects.toMatchObject({ code: UNAUTHORIZED });
  connection.close();
});

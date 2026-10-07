import { test, expect, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { APPLICATION_ERROR, createNodeConnection, createRpcPeer, methods, RpcFailure, ndjsonSocketHandler, protocolVersion, readyResult, LOCAL_MAX_FRAME_BYTES, STREAM_CHUNK_BYTES, type NdjsonSocket, type OpenStreamSource } from "@reins/node-protocol";
import { createLoopbackPair, scriptedCommandHandlers } from "@reins/node-protocol/testing";
import { listenLocalNodeSocket } from "../../nodes/local-socket.js";
import type { ServerState } from "../../state.js";
import { createServerState } from "../helpers/server-state.js";
import { dialLoopback, SEEDED_NODE_ID } from "../helpers/loopback-node.js";
import { useTestDb } from "../helpers/test-db.js";

useTestDb();

const until = async (done: () => boolean) => { for (let i = 0; i < 400 && !done(); i++) await Bun.sleep(5); expect(done()).toBe(true); };

/** What a test's `process.run` asks for; the scripted node serves whatever source the test gives it. */
const run = { sourceId: 1, cwd: "/checkout", argv: ["producer"] };

/** The seeded node as a scripted node over the loopback that serves streams: its `process.run` streams
 * the source a test opens. */
function streamingNode(state: ServerState) {
  const sources: OpenStreamSource[] = [];
  const link = dialLoopback(state, socket => createNodeConnection(socket, {
    nodeId: SEEDED_NODE_ID, minVersion: protocolVersion, maxVersion: protocolVersion, capabilities: [methods.streamCancel, methods.processRun], liveSessions: [],
    maxFrameBytes: Infinity, ...scriptedCommandHandlers({ runProcess: async () => sources.shift()! }),
  }), { redial: false });
  return {
    link,
    /** Opens a stream (`process.run`) the node serves from `source`. */
    async open(source: OpenStreamSource, { binary = false }: { binary?: boolean } = {}) {
      await link.ready();
      sources.push(source);
      return state.nodes.get(SEEDED_NODE_ID).openStream("process.run", { ...run, ...(binary ? { binary } : {}) });
    },
    /** Spawns a process the node serves from `source`. */
    async spawn(source: OpenStreamSource) {
      await link.ready();
      sources.push(source);
      return state.nodes.get(SEEDED_NODE_ID).spawn(run.argv, run);
    },
  };
}

/** A producer that yields `chunk` until it is stopped, recording that it was. */
function endless(chunk = "x".repeat(1024)) {
  const producer: { signal?: AbortSignal; stopped: boolean } = { stopped: false };
  const source: OpenStreamSource = async function* (signal) {
    producer.signal = signal;
    try { for (;;) { yield chunk; await Bun.sleep(1); } } finally { producer.stopped = true; }
  };
  return { producer, source };
}

test("a node stream reaches the server in order as a ReadableStream an HTTP response can return", async () => {
  const state = createServerState();
  const node = streamingNode(state);
  const items = Array.from({ length: 300 }, (_, i) => `line ${i}: ${"é€😀".repeat(i % 50)}\n`);
  items.push("x".repeat(3 * STREAM_CHUNK_BYTES));
  const { result, body } = await node.open(async function* () { yield* items; });
  expect(result).toEqual({});
  const response = new Response(body, { headers: { "Content-Type": "text/x-diff; charset=utf-8" } });
  expect(await response.text()).toBe(items.join(""));
  state.nodes.close();
});

test("a stream whose unread bytes pass the buffer cap fails with a clear error and stops its producer", async () => {
  const state = createServerState({}, { hub: { maxStreamBufferBytes: 64 * 1024 } });
  const node = streamingNode(state);
  const { producer, source } = endless();
  const { body } = await node.open(source);
  await until(() => producer.stopped);
  expect(producer.signal?.aborted).toBe(true);
  await expect(body.getReader().read()).rejects.toThrow("Stream exceeded its 65536-byte buffer: the consumer is not reading it");
  expect(state.nodes.get(SEEDED_NODE_ID).connected).toBe(true);
  state.nodes.close();
});

test("cancelling a stream's body stops the node's producer", async () => {
  const state = createServerState();
  const node = streamingNode(state);
  const { producer, source } = endless();
  const { body } = await node.open(source);
  const reader = body.getReader();
  expect((await reader.read()).value).toBeInstanceOf(Uint8Array);
  await reader.cancel();
  await until(() => producer.stopped);
  expect(producer.signal?.aborted).toBe(true);
  state.nodes.close();
});

test("a node failing its stream fails the body and `ended` with the node's message", async () => {
  const state = createServerState();
  const node = streamingNode(state);
  const { body, ended } = await node.open(async function* () { yield "partial"; throw new Error("git exited with 128"); });
  const reader = body.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("partial");
  await expect(reader.read()).rejects.toThrow("git exited with 128");
  await expect(ended).rejects.toThrow("git exited with 128");
  state.nodes.close();
});

test("a binary stream's body is its exact bytes, and `ended` resolves with how its process ended", async () => {
  const state = createServerState();
  const node = streamingNode(state);
  const bytes = new Uint8Array(3 * STREAM_CHUNK_BYTES).map((_, i) => (i * 7) % 256);
  const exit = { code: 2, signal: null, stderr: "warning: something\n" };
  const { body, ended } = await node.open(async function* () { yield bytes; return exit; }, { binary: true });
  expect(new Uint8Array(await new Response(body).arrayBuffer())).toEqual(bytes);
  expect(await ended).toEqual(exit);
  state.nodes.close();
});

test("a spawned process's stdout and exit reach the server; cancelling stdout stops the process", async () => {
  const state = createServerState();
  const node = streamingNode(state);
  const exit = { code: 1, signal: null, stderr: "fatal: bad revision\n" };
  const finished = await node.spawn(async function* () { yield "out"; return exit; });
  expect(await new Response(finished.stdout).text()).toBe("out");
  expect(await finished.exited).toEqual(exit);

  const { producer, source } = endless();
  const running = await node.spawn(source);
  await running.stdout.cancel();
  await until(() => producer.stopped);
  await expect(running.exited).rejects.toThrow("Stream cancelled");
  state.nodes.close();
});

test("a dropped link errors every open stream and stops their producers", async () => {
  const state = createServerState();
  const node = streamingNode(state);
  const first = endless();
  const second = endless();
  const streams = [await node.open(first.source), await node.open(second.source)];
  node.link.drop();
  for (const { body } of streams) await expect(new Response(body).text()).rejects.toThrow("Node connection closed");
  await until(() => first.producer.stopped && second.producer.stopped);
  state.nodes.close();
});

/** A raw node end on the hub, negotiated as the seeded node, answering `process.run` and sending stream
 * frames by hand. `opening` runs before it answers a `process.run`: it may send frames, or throw to
 * refuse the request. */
async function rawNode(state: ServerState, capabilities: string[] = [methods.streamCancel, methods.processRun]) {
  const [serverEnd, nodeEnd] = createLoopbackPair();
  state.nodes.accept(serverEnd, { maxFrameBytes: Infinity });
  const cancelled: string[] = [];
  const opened: string[] = [];
  let opening: ((streamId: string) => void) | undefined;
  const peer = createRpcPeer(nodeEnd, {
    "stream.cancel": { params: z.object({ streamId: z.string() }), notify: ({ streamId }) => { cancelled.push(streamId); } },
    "process.run": { params: z.object({ streamId: z.string() }).loose(), result: z.object({}), handle: async ({ streamId }) => { opened.push(streamId); opening?.(streamId); return {}; } },
  });
  nodeEnd.onmessage = peer.receive;
  const { epoch } = await peer.call("node.hello", { nodeId: SEEDED_NODE_ID, minVersion: protocolVersion, maxVersion: protocolVersion, capabilities, liveSessions: [] }, readyResult);
  await until(() => state.nodes.get(SEEDED_NODE_ID).connected);
  const data = (streamId: string, offset: number, chunk: string) => peer.notify("stream.data", { epoch, streamId, offset, data: chunk });
  const end = (streamId: string, error?: string) => peer.notify("stream.end", { epoch, streamId, ...(error === undefined ? {} : { error }) });
  return {
    cancelled, opened, data, end,
    set opening(handler: (streamId: string) => void) { opening = handler; },
    /** Opens a stream; its ID is the one the node was sent. */
    async open() {
      const stream = await state.nodes.get(SEEDED_NODE_ID).openStream("process.run", run);
      return { ...stream, streamId: opened.at(-1)! };
    },
  };
}

test("chunks the node sends before its reply to the opening request reach the stream", async () => {
  const state = createServerState();
  const node = await rawNode(state);
  // The whole stream, its end included, crosses before the reply.
  node.opening = streamId => { node.data(streamId, 0, "before "); node.data(streamId, 7, "the reply"); node.end(streamId); };
  const { body } = await node.open();
  expect(await new Response(body).text()).toBe("before the reply");
  state.nodes.close();
});

test("offsets count UTF-8 bytes; a gap fails only that stream, a chunk for an unknown stream is dropped, and the node is told to stop both", async () => {
  const state = createServerState();
  const node = await rawNode(state);
  const debug = spyOn(console, "debug").mockImplementation(() => {});
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const gap = await node.open();
    node.data(gap.streamId, 0, "é");
    node.data(gap.streamId, 3, "x");
    await expect(new Response(gap.body).text()).rejects.toThrow(`Stream ${gap.streamId} offset gap: expected byte 2, got 3`);
    node.data("unknown", 0, "x");
    await until(() => node.cancelled.length === 2);
    expect(node.cancelled).toEqual([gap.streamId, "unknown"]);
    // The connection still serves streams.
    const next = await node.open();
    node.data(next.streamId, 0, "é");
    node.data(next.streamId, 2, "!");
    node.end(next.streamId);
    expect(await new Response(next.body).text()).toBe("é!");
  } finally { debug.mockRestore(); warn.mockRestore(); state.nodes.close(); }
});

test("a refused opening request rejects with the node's error and tells the node to cancel; a node without streams cannot be asked for one", async () => {
  const state = createServerState();
  const node = await rawNode(state);
  node.opening = () => { throw new RpcFailure(APPLICATION_ERROR, "Not a git repository"); };
  await expect(node.open()).rejects.toThrow("Not a git repository");
  await until(() => node.cancelled.length === 1);
  expect(node.cancelled).toEqual(node.opened);
  state.nodes.close();

  const legacy = createServerState();
  const old = await rawNode(legacy, [methods.processRun]);
  await expect(legacy.nodes.get(SEEDED_NODE_ID).openStream("process.run", run)).rejects.toThrow("Node capability not negotiated");
  expect(old.opened).toEqual([]);
  await expect(legacy.nodes.get("remote").openStream("process.run", run)).rejects.toThrow("Node not connected");
  legacy.nodes.close();
});

test("over the real socket, a large stream is paced by the socket's drain so other frames interleave between its chunks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reins-streams-"));
  const state = createServerState();
  const path = join(dir, "run", "node.sock");
  const listener = await listenLocalNodeSocket(path, socket => state.nodes.accept(socket));
  let wire!: NdjsonSocket;
  let connection!: ReturnType<typeof createNodeConnection>;
  const piece = "y".repeat(STREAM_CHUNK_BYTES);
  const pieces = 512;
  let mostQueued = 0;
  try {
    await Bun.connect({ unix: path, socket: ndjsonSocketHandler(LOCAL_MAX_FRAME_BYTES, opened => {
      wire = opened;
      connection = createNodeConnection(opened, {
        nodeId: SEEDED_NODE_ID, minVersion: protocolVersion, maxVersion: protocolVersion, capabilities: [methods.streamCancel, methods.processRun, methods.skillsList], liveSessions: [],
        ...scriptedCommandHandlers({
          listSkills: async () => ({ skills: [{ name: "review", description: "Reviews code" }] }),
          // A fast in-memory source: unpaced, its 32 MiB would all be queued on the node's socket at once.
          runProcess: async () => async function* () {
            for (let i = 0; i < pieces; i++) { mostQueued = Math.max(mostQueued, wire.queuedBytes); yield piece; }
          },
        }),
      });
      opened.onmessage = connection.receive;
      opened.onclose = connection.close;
    }) });
    await connection.ready;
    await until(() => state.nodes.get(SEEDED_NODE_ID).connected);
    const node = state.nodes.get(SEEDED_NODE_ID);
    const { body } = await node.openStream("process.run", run);
    const reader = body.getReader();
    let received = 0;
    let receivedAtReply: number | undefined;
    const skills = node.request("skills.list", { sourceId: 1, cwd: dir }).then(result => { receivedAtReply = received; return result.skills; });
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) received += chunk.value.byteLength;
    expect(received).toBe(pieces * STREAM_CHUNK_BYTES);
    expect(await skills).toEqual([{ name: "review", description: "Reviews code" }]);
    // The reply crossed while the stream was still flowing, not after it.
    expect(receivedAtReply).toBeLessThan(received / 2);
    // Each chunk waited for the socket to write out the one before it.
    expect(mostQueued).toBeLessThan(STREAM_CHUNK_BYTES);
  } finally {
    wire?.close(); listener.stop(); state.nodes.close(); rmSync(dir, { recursive: true, force: true });
  }
});

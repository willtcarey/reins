import { test, expect, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createNodeConnection, createRpcPeer, methods, ndjsonSocketHandler, protocolVersion, readyResult, LOCAL_MAX_FRAME_BYTES, STREAM_CHUNK_BYTES, type NdjsonSocket, type NodeCommandHandlers, type OpenStreamSource } from "@reins/node-protocol";
import { createLoopbackPair, scriptedCommandHandlers } from "@reins/node-protocol/testing";
import { listenLocalNodeSocket } from "../../node-link/local-socket.js";
import type { ServerState } from "../../state.js";
import { createServerState } from "../helpers/server-state.js";
import { dialLoopback, SEEDED_NODE_ID } from "../helpers/loopback-node.js";
import { useTestDb } from "../helpers/test-db.js";

useTestDb();

const until = async (done: () => boolean) => { for (let i = 0; i < 400 && !done(); i++) await Bun.sleep(5); expect(done()).toBe(true); };

/** The seeded node as a scripted node over the loopback that advertises streams. A test opens a stream
 * by serving it from this connection inside `openStream`'s request, standing in for the handler of a
 * stream-opening request. */
function streamingNode(state: ServerState, handlers: Partial<NodeCommandHandlers> = {}) {
  let connection!: ReturnType<typeof createNodeConnection>;
  const link = dialLoopback(state, socket => connection = createNodeConnection(socket, {
    nodeId: SEEDED_NODE_ID, minVersion: protocolVersion, maxVersion: protocolVersion, capabilities: [methods.streamCancel, methods.skillsList], liveSessions: [],
    maxFrameBytes: Infinity, ...scriptedCommandHandlers(handlers),
  }), { redial: false });
  return {
    link,
    connection: () => connection,
    /** Opens a stream the node serves from `source`; the opening request answers `{ opened: true }`. */
    async open(source: OpenStreamSource) {
      await link.ready();
      return state.nodes.openStream(SEEDED_NODE_ID, async (_node, streamId) => { void connection.stream(streamId, source); return { opened: true }; });
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

test("a node stream reaches the server in order as a ReadableStream an HTTP response can return, including chunks sent before the opening request was answered", async () => {
  const state = createServerState();
  const node = streamingNode(state);
  await node.link.ready();
  const items = Array.from({ length: 300 }, (_, i) => `line ${i}: ${"é€😀".repeat(i % 50)}\n`);
  items.push("x".repeat(3 * STREAM_CHUNK_BYTES));
  const { result, body } = await state.nodes.openStream(SEEDED_NODE_ID, async (_client, streamId) => {
    // The whole stream, its end included, crosses before the reply.
    await node.connection().stream(streamId, async function* () { yield* items; });
    return { opened: true };
  });
  expect(result).toEqual({ opened: true });
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
  expect(state.nodes.connected(SEEDED_NODE_ID)).toBe(true);
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

test("a node failing its stream fails the body with the node's message", async () => {
  const state = createServerState();
  const node = streamingNode(state);
  const { body } = await node.open(async function* () { yield "partial"; throw new Error("git exited with 128"); });
  const reader = body.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("partial");
  await expect(reader.read()).rejects.toThrow("git exited with 128");
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

/** A raw node end on the hub, negotiated as the seeded node, sending stream frames by hand. */
async function rawNode(state: ServerState, capabilities: string[] = [methods.streamCancel]) {
  const [serverEnd, nodeEnd] = createLoopbackPair();
  state.nodes.accept(serverEnd, { maxFrameBytes: Infinity });
  const cancelled: string[] = [];
  const peer = createRpcPeer(nodeEnd, { "stream.cancel": { params: z.object({ streamId: z.string() }), notify: ({ streamId }) => { cancelled.push(streamId); } } });
  nodeEnd.onmessage = peer.receive;
  const { epoch } = await peer.call("node.hello", { nodeId: SEEDED_NODE_ID, minVersion: protocolVersion, maxVersion: protocolVersion, capabilities, liveSessions: [] }, readyResult);
  await until(() => state.nodes.connected(SEEDED_NODE_ID));
  return {
    cancelled,
    data: (streamId: string, offset: number, data: string) => peer.notify("stream.data", { epoch, streamId, offset, data }),
    end: (streamId: string, error?: string) => peer.notify("stream.end", { epoch, streamId, ...(error === undefined ? {} : { error }) }),
    open: () => state.nodes.openStream(SEEDED_NODE_ID, async (_client, streamId) => streamId),
  };
}

test("offsets count UTF-8 bytes; a gap fails only that stream, a chunk for an unknown stream is dropped, and the node is told to stop both", async () => {
  const state = createServerState();
  const node = await rawNode(state);
  const debug = spyOn(console, "debug").mockImplementation(() => {});
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const gap = await node.open();
    node.data(gap.result, 0, "é");
    node.data(gap.result, 3, "x");
    await expect(new Response(gap.body).text()).rejects.toThrow(`Stream ${gap.result} offset gap: expected byte 2, got 3`);
    node.data("unknown", 0, "x");
    await until(() => node.cancelled.length === 2);
    expect(node.cancelled).toEqual([gap.result, "unknown"]);
    // The connection still serves streams.
    const next = await node.open();
    node.data(next.result, 0, "é");
    node.data(next.result, 2, "!");
    node.end(next.result);
    expect(await new Response(next.body).text()).toBe("é!");
  } finally { debug.mockRestore(); warn.mockRestore(); state.nodes.close(); }
});

test("a refused opening request rejects with the node's error and tells the node to cancel; a node without streams cannot be asked for one", async () => {
  const state = createServerState();
  const node = await rawNode(state);
  const opened: string[] = [];
  await expect(state.nodes.openStream(SEEDED_NODE_ID, async (_client, streamId) => { opened.push(streamId); throw new Error("Not a git repository"); })).rejects.toThrow("Not a git repository");
  await until(() => node.cancelled.length === 1);
  expect(node.cancelled).toEqual(opened);
  state.nodes.close();

  const legacy = createServerState();
  await rawNode(legacy, []);
  let asked = false;
  await expect(legacy.nodes.openStream(SEEDED_NODE_ID, async () => { asked = true; })).rejects.toThrow("Node capability not negotiated");
  expect(asked).toBe(false);
  await expect(legacy.nodes.openStream("remote", async () => undefined)).rejects.toThrow("Node not connected");
  legacy.nodes.close();
});

test("over the real socket, a large stream is paced by the socket's drain so other frames interleave between its chunks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reins-streams-"));
  const state = createServerState();
  const path = join(dir, "run", "node.sock");
  const listener = await listenLocalNodeSocket(path, socket => state.nodes.accept(socket));
  let wire!: NdjsonSocket;
  let connection!: ReturnType<typeof createNodeConnection>;
  try {
    await Bun.connect({ unix: path, socket: ndjsonSocketHandler(LOCAL_MAX_FRAME_BYTES, opened => {
      wire = opened;
      connection = createNodeConnection(opened, {
        nodeId: SEEDED_NODE_ID, minVersion: protocolVersion, maxVersion: protocolVersion, capabilities: [methods.streamCancel, methods.skillsList], liveSessions: [],
        ...scriptedCommandHandlers({ listSkills: async () => ({ skills: [{ name: "review", description: "Reviews code" }] }) }),
      });
      opened.onmessage = connection.receive;
      opened.onclose = connection.close;
    }) });
    await connection.ready;
    await until(() => state.nodes.connected(SEEDED_NODE_ID));
    // A fast in-memory source: unpaced, its 32 MiB would all be queued on the node's socket at once.
    const piece = "y".repeat(STREAM_CHUNK_BYTES);
    const pieces = 512;
    let mostQueued = 0;
    const { body } = await state.nodes.openStream(SEEDED_NODE_ID, async (_client, streamId) => {
      void connection.stream(streamId, async function* () {
        for (let i = 0; i < pieces; i++) { mostQueued = Math.max(mostQueued, wire.queuedBytes); yield piece; }
      });
    });
    const reader = body.getReader();
    let received = 0;
    let receivedAtReply: number | undefined;
    const skills = state.nodes.listSkills(SEEDED_NODE_ID, { sourceId: 1, cwd: dir }).then(result => { receivedAtReply = received; return result; });
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

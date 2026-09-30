import { scriptedCommandHandlers } from "@reins/node-protocol/testing";
import { test, expect, spyOn } from "bun:test";
import { createServerTransport, type NodeSessionEvent, type ServerAttachment, type ServerHandlers } from "../../node-link/server-peer.js";
import { createNodeConnection, protocolVersion, ATTACHMENT_CHUNK_BYTES, MAX_ATTACHMENT_BYTES } from "@reins/node-protocol";
import { createLoopbackPair } from "@reins/node-protocol/testing";
import { createHash } from "node:crypto";
import { startNode, type Node } from "@reins/node/node";
import { connectNode } from "@reins/node/node-connection";

const unexpected = () => { throw new Error("unexpected"); };
const noServer = { started: unexpected, settled: unexpected, attachment: () => null, event: () => {}, scriptExecute: unexpected, scriptSearch: unexpected, createTask: unexpected, findAttachment: () => null, storeAttachment: unexpected, readCredential: async () => null, refreshCredential: async () => null, listCredentials: async () => [], storageRead: unexpected, storageCommit: unexpected };

const binding = { sourceId: 1, cwd: "/tmp/server-calls", createdAt: "2026-01-01", parentSessionId: null };

function link(node: Node, handlers: ServerHandlers | (() => ServerHandlers)) {
  const [serverEnd, nodeEnd] = createLoopbackPair();
  const server = createServerTransport(serverEnd, typeof handlers === "function" ? handlers : () => handlers);
  const connection = connectNode(node, nodeEnd, "test");
  serverEnd.onmessage = server.receive; serverEnd.onclose = server.close;
  nodeEnd.onmessage = connection.receive; nodeEnd.onclose = connection.close;
  return { serverEnd, connection, close: () => serverEnd.close() };
}

async function withNode(run: (node: Node) => Promise<void>) {
  const node = startNode();
  try { await run(node); } finally { await node.shutdown(); }
}

const until = async (done: () => boolean) => { for (let i = 0; i < 200 && !done(); i++) await Bun.sleep(5); };
const unexpectedTool = () => { throw new Error("unexpected tool call"); };
const noTools = { scriptExecute: unexpectedTool, scriptSearch: unexpectedTool, createTask: unexpectedTool, findAttachment: () => null, storeAttachment: () => { throw new Error("unexpected attachment store"); }, readCredential: async () => null, refreshCredential: async () => null, listCredentials: async () => [], storageRead: unexpectedTool, storageCommit: unexpectedTool };
const noReports = { started: () => { throw new Error("unexpected report"); }, settled: () => { throw new Error("unexpected report"); }, ...noTools };

test("private loopback WS negotiates, then runs submitted work and controls", async () => {
  let serverPeer: ReturnType<typeof createServerTransport> | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request, instance) {
      if (new URL(request.url).pathname !== "/test-only" || !instance.upgrade(request)) return new Response("Forbidden", { status: 403 });
    },
    websocket: {
      open(ws) { serverPeer = createServerTransport({ send: data => ws.send(data), close: () => ws.close() }, () => noServer); },
      message(_ws, message) { serverPeer?.receive(message); },
      close() { serverPeer?.close(); },
    },
  });
  const client = new WebSocket(`ws://127.0.0.1:${server.port}/test-only`);
  let node: ReturnType<typeof createNodeConnection> | undefined;
  const sessions = new Map<string, number>();
  try {
    await new Promise<void>((resolve, reject) => { client.addEventListener("open", () => resolve(), { once: true }); client.addEventListener("error", () => reject(new Error("WebSocket failed")), { once: true }); });
    node = createNodeConnection({ send: data => client.send(data), close: () => client.close() }, {
      nodeId: "test-node", minVersion: protocolVersion - 1, maxVersion: protocolVersion + 1, capabilities: ["session.prompt", "session.abort", "future.optional"], liveSessions: [],
      ...scriptedCommandHandlers({
        prompt: async input => { sessions.set(input.sessionId, input.binding.sourceId); return { inputId: input.clientId }; },
        abort: async ({ sessionId }) => ({ aborted: sessions.has(sessionId) }),
      }),
    });
    client.addEventListener("message", event => node?.receive(event.data));
    client.addEventListener("close", () => node?.close());
    expect((await fetch(`http://127.0.0.1:${server.port}/`)).status).toBe(403);
    const ready = await node.ready;
    expect(ready.version).toBe(protocolVersion);
    expect(ready.capabilities).toEqual(["session.prompt", "session.abort"]);
    expect(ready.epoch).toBeString();
    const peer = serverPeer!;
    expect(await peer.abort({ sessionId: "s1", binding })).toEqual({ aborted: false });
    expect(await peer.prompt({ sessionId: "s1", binding, task: null, lane: { model: null, thinkingLevel: null }, clientId: "c1", content: [{ type: "text", text: "Hi" }], sourceSessionId: null }))
      .toEqual({ inputId: "c1" });
    expect(await peer.abort({ sessionId: "s1", binding })).toEqual({ aborted: true });
  } finally {
    node?.close(); serverPeer?.close(); client.close(); server.stop(true);
  }
});

test("server transport rejects operations before negotiation and incompatible versions", async () => {
  const sent: string[] = [];
  const peer = createServerTransport({ send: data => sent.push(data), close: () => {} }, () => noServer);
  await expect(peer.abort({ sessionId: "s1", binding })).rejects.toMatchObject({ code: "unavailable" });
  peer.receive(JSON.stringify({ jsonrpc: "2.0", method: "node.hello", params: { minVersion: protocolVersion + 1, maxVersion: protocolVersion + 2, capabilities: ["session.abort"], nodeId: "x", liveSessions: [] }, id: 1 }));
  await Bun.sleep(0);
  expect(JSON.parse(sent[0]!)).toMatchObject({ jsonrpc: "2.0", id: 1, error: { code: -32001 } });
  await expect(peer.abort({ sessionId: "s1", binding })).rejects.toMatchObject({ code: "unavailable" });
  peer.close();
});

test("a command the server sends right behind its hello reply (same read) is served, not rejected as stale", async () => {
  const EPOCH = crypto.randomUUID();
  const sent: Array<{ id?: number | string; method?: string; result?: unknown; error?: { code: number } }> = [];
  const node = createNodeConnection({ send: data => sent.push(JSON.parse(data)), close: () => {} }, {
    nodeId: "n", minVersion: protocolVersion, maxVersion: protocolVersion, capabilities: ["session.close"], liveSessions: [],
    ...scriptedCommandHandlers({ close: async () => ({ closed: true }) }),
  });
  const hello = sent.find(frame => frame.method === "node.hello")!;
  // The server replies to hello and immediately delivers a queued command (a reconnect replay).
  node.receive(JSON.stringify({ jsonrpc: "2.0", id: hello.id, result: { version: protocolVersion, capabilities: ["session.close"], epoch: EPOCH } }));
  node.receive(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "session.close", params: { epoch: EPOCH, sessionId: "s" } }));
  await node.ready;
  for (let i = 0; i < 20 && !sent.some(frame => frame.id === 7); i++) await Bun.sleep(1);
  expect(sent.find(frame => frame.id === 7)).toMatchObject({ result: { closed: true } });
  node.close();
});
test("a negotiated link uses new product handlers for subsequent calls while an in-flight call finishes with its original handlers", async () => {
  await withNode(async node => {
    const held = Promise.withResolvers<{ type: "api_key"; key: string }>();
    const reached = Promise.withResolvers<void>();
    let handlers: ServerHandlers = {
      ...noReports, attachment: () => null, event: () => {},
      readCredential: async () => { reached.resolve(); return held.promise; },
    };
    const live = link(node, () => handlers);
    try {
      const before = await live.connection.ready;
      const inFlight = live.connection.getCredential("provider");
      await reached.promise;
      handlers = { ...handlers, readCredential: async () => ({ type: "api_key", key: "new" }) };
      expect(await live.connection.getCredential("provider")).toEqual({ type: "api_key", key: "new" });
      held.resolve({ type: "api_key", key: "old" });
      expect(await inFlight).toEqual({ type: "api_key", key: "old" });
      expect((await live.connection.ready).epoch).toBe(before.epoch);
      expect(live.serverEnd.closed).toBe(false);
    } finally { live.close(); }
  });
});

test("attachment fetch transfers chunked base64 bytes that the node verifies before caching", async () => {
  const bytes = new Uint8Array(ATTACHMENT_CHUNK_BYTES * 2 + 17).map((_, i) => (i * 31) % 251);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let served: ServerAttachment | null = { data: bytes, mimeType: "image/png", byteSize: bytes.length, sha256, filename: "a.png", width: 3, height: 4 };
  let fetches = 0;
  const prompt = (node: Node, clientId: string, attachmentId: string) => node.prompt({ sessionId: "s", binding, task: null, lane: { model: null, thinkingLevel: null }, clientId, sourceSessionId: null,
    content: [{ type: "image" as const, attachmentId, mimeType: "image/png" as const, byteSize: bytes.length }] });
  await withNode(async node => {
    const live = link(node, { attachment: (sessionId, id) => {
      if (sessionId !== "s") throw new Error("wrong session");
      if (id === "img") fetches++;
      return served;
    }, event: () => {}, ...noReports, storageRead: async () => { throw new Error("no storage here"); } });
    // The attachment is cached before Pi opens (this server serves no storage, so the open fails); a
    // second prompt uses the cached bytes.
    await expect(prompt(node, "a", "img")).rejects.toThrow("no storage here");
    expect(fetches).toBe(3);
    await expect(prompt(node, "a", "img")).rejects.toThrow("no storage here");
    expect(fetches).toBe(3);

    served = { ...served!, sha256: "0".repeat(64) };
    await expect(prompt(node, "b", "corrupt")).rejects.toMatchObject({ error: { code: "invalid_request", message: "Attachment checksum mismatch: corrupt" } });
    served = { ...served, data: new Uint8Array(MAX_ATTACHMENT_BYTES + 1), byteSize: MAX_ATTACHMENT_BYTES + 1 };
    await expect(prompt(node, "c", "huge")).rejects.toMatchObject({ error: {
      code: "invalid_request", retryable: false, message: expect.stringContaining("exceeds 10485760 byte transfer limit") } });
    served = null;
    await expect(prompt(node, "d", "gone")).rejects.toMatchObject({ error: { code: "invalid_request", message: "Attachment unavailable: gone" } });
    live.close();
  });
});

test("server rejects node calls with malformed params or an epoch it did not issue", async () => {
  const sent: Array<{ id: number; error?: { code: number } }> = [];
  const server = createServerTransport({ send: data => sent.push(JSON.parse(data)), close: () => {} }, () => ({
    attachment: () => { throw new Error("must not read"); }, event: () => { throw new Error("must not observe"); }, ...noReports,
  }));
  const frame = (id: number, method: string, params: unknown) => server.receive(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  const epoch = crypto.randomUUID();
  frame(1, "attachment.fetch", { epoch, sessionId: "s", attachmentId: "a", offset: 0 });
  frame(2, "attachment.fetch", { epoch, sessionId: "s", attachmentId: "a", offset: -1 });
  frame(3, "session.started", { epoch, sessionId: "s", runId: "r" });
  frame(4, "session.settled", { epoch, sessionId: "s", runId: "r", status: "running", metadata: { model: null, thinkingLevel: null }, tipId: null });
  frame(5, "storage.commit", { epoch, sessionId: "s", writes: "not writes" });
  await Bun.sleep(5);
  expect(sent.map(reply => [reply.id, reply.error?.code]).toSorted((a, b) => a[0]! - b[0]!)).toEqual([[1, -32003], [2, -32602], [3, -32003], [4, -32602], [5, -32602]]);
  server.close();
});

test("attachment.store resumes from the server's contiguous prefix and stores only verified bytes under the node's ID", async () => {
  const sent: Array<{ id?: number; result?: any; error?: { code: number; message: string } }> = [];
  const stored = new Map<string, ServerAttachment>();
  const server = createServerTransport({ send: data => sent.push(JSON.parse(data)), close: () => {} }, () => ({
    attachment: () => null, event: () => {}, ...noReports,
    findAttachment: (_sessionId, attachmentId) => {
      const held = stored.get(attachmentId);
      return held ? { attachmentId, mimeType: held.mimeType, byteSize: held.byteSize, sha256: held.sha256 } : null;
    },
    storeAttachment: (_sessionId, attachmentId, attachment) => { stored.set(attachmentId, attachment); },
  }));
  let id = 1;
  const call = async (method: string, params: unknown) => {
    const request = ++id;
    server.receive(JSON.stringify({ jsonrpc: "2.0", id: request, method, params }));
    await Bun.sleep(1);
    return sent.find(reply => reply.id === request)!;
  };
  server.receive(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "node.hello", params: { minVersion: protocolVersion, maxVersion: protocolVersion, capabilities: [], nodeId: "n", liveSessions: [] } }));
  await Bun.sleep(1);
  const epoch = sent[0]!.result.epoch;
  const bytes = Buffer.alloc(ATTACHMENT_CHUNK_BYTES + 10, 7);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const chunk = (offset: number, data = bytes.subarray(offset, offset + ATTACHMENT_CHUNK_BYTES), attachmentId = "att_node", mimeType = "image/png") =>
    call("attachment.store", { epoch, sessionId: "s", attachmentId, mimeType, sha256, byteSize: bytes.length, offset, data: data.toString("base64") });
  expect((await chunk(ATTACHMENT_CHUNK_BYTES)).result).toEqual({ nextOffset: 0 }); // nothing held yet: start at 0
  expect((await chunk(0)).result).toEqual({ nextOffset: ATTACHMENT_CHUNK_BYTES });
  expect((await chunk(0)).result).toEqual({ nextOffset: ATTACHMENT_CHUNK_BYTES }); // retried chunk is not appended twice
  // The same ID with other metadata mid-upload is rejected and restarts.
  expect((await chunk(ATTACHMENT_CHUNK_BYTES, undefined, "att_node", "image/gif")).error).toMatchObject({ code: -32000, message: "Attachment upload changed: att_node" });
  expect((await chunk(ATTACHMENT_CHUNK_BYTES)).result).toEqual({ nextOffset: 0 });
  expect((await chunk(0)).result).toEqual({ nextOffset: ATTACHMENT_CHUNK_BYTES });
  expect(stored.size).toBe(0);
  expect((await chunk(ATTACHMENT_CHUNK_BYTES)).result).toEqual({ stored: true });
  expect([...stored.keys()]).toEqual(["att_node"]);
  expect(Buffer.from(stored.get("att_node")!.data)).toEqual(bytes);
  // A replay of a stored ID is answered at once; the same ID with different content is divergence.
  expect((await chunk(0)).result).toEqual({ stored: true });
  expect((await chunk(0, undefined, "att_node", "image/gif")).error).toMatchObject({ code: -32000, message: "Attachment att_node is already stored with different content" });
  // Tampered bytes fail verification and leave nothing buffered.
  expect((await chunk(0, undefined, "att_other")).result).toEqual({ nextOffset: ATTACHMENT_CHUNK_BYTES });
  expect((await chunk(ATTACHMENT_CHUNK_BYTES, Buffer.alloc(10, 8), "att_other")).error).toMatchObject({ code: -32000, message: "Attachment checksum mismatch: att_other" });
  expect((await chunk(ATTACHMENT_CHUNK_BYTES, undefined, "att_other")).result).toEqual({ nextOffset: 0 });
  expect(stored.size).toBe(1);
  expect((await call("attachment.store", { epoch: crypto.randomUUID(), sessionId: "s", attachmentId: "att_x", mimeType: "image/png", sha256, byteSize: 1, offset: 0, data: "AA==" })).error).toMatchObject({ code: -32003 });
  server.close();
});

test("session events reach the handler only for the issued epoch, in order, with gaps counted and no replies", async () => {
  const sent: Array<{ id?: number; result?: { epoch: string } }> = [];
  const received: NodeSessionEvent[] = [];
  const server = createServerTransport({ send: data => sent.push(JSON.parse(data)), close: () => {} }, () => ({
    attachment: () => null, event: input => { received.push(input); }, ...noReports,
  }));
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    server.receive(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "node.hello", params: { minVersion: protocolVersion, maxVersion: protocolVersion, capabilities: [], nodeId: "n", liveSessions: [] } }));
    await Bun.sleep(1);
    const epoch = sent[0]!.result!.epoch;
    const event = (params: Record<string, unknown>) => server.receive(JSON.stringify({ jsonrpc: "2.0", method: "session.event", params: { epoch, sessionId: "s", ...params } }));
    event({ seq: 1, emittedAt: 0, event: '{"type":"agent_start"}' });
    event({ seq: 1, emittedAt: 0, event: '{"type":"agent_end"}' }); // replayed seq
    event({ seq: 4, emittedAt: 0, event: '{"type":"unknown_kind"}' }); // the payload is the node's, relayed unread
    event({ seq: 5, emittedAt: 0, epoch: crypto.randomUUID(), event: '{"type":"agent_start"}' });
    event({ seq: 6, emittedAt: 0, event: { type: "agent_start" } }); // not serialized: an invalid envelope
    await Bun.sleep(1);
    expect(received).toEqual([
      { sessionId: "s", seq: 1, missed: 0, emittedAt: 0, event: '{"type":"agent_start"}' },
      { sessionId: "s", seq: 4, missed: 2, emittedAt: 0, event: '{"type":"unknown_kind"}' },
    ]);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(sent).toHaveLength(1);
  } finally { warn.mockRestore(); server.close(); }
});

test("script.execute abort stops the node waiting, cancels the server script's signal, and a closed link cancels in-flight scripts", async () => {
  await withNode(async node => {
    const signals: AbortSignal[] = [];
    const running = (_input: unknown, signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
      signals.push(signal);
      signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    });
    const live = link(node, { attachment: () => null, event: () => {}, ...noReports, scriptExecute: running });
    const controller = new AbortController();
    const call = live.connection.executeScript({ sessionId: "s", code: "await forever" }, controller.signal);
    await until(() => signals.length === 1);
    controller.abort();
    await expect(call).rejects.toMatchObject({ message: "Call aborted; outcome unknown", outcome: "unknown" });
    await until(() => signals[0]!.aborted);
    expect(signals[0]!.aborted).toBe(true);

    const orphan = live.connection.executeScript({ sessionId: "s", code: "await forever" });
    await until(() => signals.length === 2);
    live.close();
    await expect(orphan).rejects.toMatchObject({ outcome: "unknown" });
    await until(() => signals[1]!.aborted);
    expect(signals[1]!.aborted).toBe(true);
  });
});

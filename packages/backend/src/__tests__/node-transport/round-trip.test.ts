import { test, expect } from "bun:test";
import { createServerTransport } from "../../node-transport/server-peer.js";
import { createNodeConnection, protocolVersion } from "@reins/node-protocol";
import { scriptedCommandHandlers } from "@reins/node-protocol/testing";

const unexpected = () => { throw new Error("unexpected"); };
const noServer = { started: unexpected, settled: unexpected, attachment: () => null, event: () => {}, scriptExecute: unexpected, scriptSearch: unexpected, createTask: unexpected, findAttachment: () => null, storeAttachment: unexpected, readCredential: async () => null, refreshCredential: async () => null, listCredentials: async () => [], storageRead: unexpected, storageCommit: unexpected };

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
        prompt: async ({ sessionId, binding, clientId }) => { sessions.set(sessionId, binding.sourceId); return { inputId: clientId }; },
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
    const binding = { sourceId: 2, cwd: "/tmp/project", createdAt: "2026-01-01T00:00:00Z", parentSessionId: null };
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
  const binding = { sourceId: 1, cwd: "/tmp", createdAt: "now", parentSessionId: null };
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

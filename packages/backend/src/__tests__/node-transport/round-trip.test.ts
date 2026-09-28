import { test, expect } from "bun:test";
import { createServerTransport } from "../../node-transport/server-peer.js";
import { createNodeConnection } from "@reins/node/protocol";
import { scriptedCommandHandlers } from "@reins/node/testing";

const unexpected = () => { throw new Error("unexpected"); };
const noServer = { committed: unexpected, started: unexpected, settled: unexpected, attachment: () => null, event: () => {}, scriptExecute: unexpected, scriptSearch: unexpected, createTask: unexpected, findAttachment: () => null, storeAttachment: unexpected, readCredential: async () => null, refreshCredential: async () => null, listCredentials: async () => [], snapshot: () => { throw new Error("unexpected session snapshot"); } };

test("private loopback WS negotiates and provisions then reports status", async () => {
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
      nodeId: "test-node", minVersion: 1, maxVersion: 2, capabilities: ["session.provision", "session.abort", "future.optional"],
      ...scriptedCommandHandlers({
        provision: async ({ sessionId, binding }) => { sessions.set(sessionId, binding.sourceId); return { provisioned: true }; },
        abort: async ({ sessionId }) => ({ aborted: sessions.has(sessionId) }),
      }),
    });
    client.addEventListener("message", event => node?.receive(event.data));
    client.addEventListener("close", () => node?.close());
    expect((await fetch(`http://127.0.0.1:${server.port}/`)).status).toBe(403);
    const ready = await node.ready;
    expect(ready.version).toBe(1);
    expect(ready.capabilities).toEqual(["session.provision", "session.abort"]);
    expect(ready.epoch).toBeString();
    const peer = serverPeer!;
    const binding = { sourceId: 2, cwd: "/tmp/project", createdAt: "2026-01-01T00:00:00Z", parentSessionId: null };
    expect(await peer.abort({ sessionId: "s1", binding })).toEqual({ aborted: false });
    expect(await peer.provision({ sessionId: "s1", binding, configuration: { model: null, thinkingLevel: null, task: null } })).toEqual({ provisioned: true });
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
  peer.receive(JSON.stringify({ jsonrpc: "2.0", method: "node.hello", params: { minVersion: 2, maxVersion: 3, capabilities: ["session.provision"], nodeId: "x" }, id: 1 }));
  await Bun.sleep(0);
  expect(JSON.parse(sent[0]!)).toMatchObject({ jsonrpc: "2.0", id: 1, error: { code: -32001 } });
  await expect(peer.provision({ sessionId: "s1", binding, configuration: { model: null, thinkingLevel: null, task: null } })).rejects.toMatchObject({ code: "unavailable" });
  peer.close();
});

test("a command the server sends right behind its hello reply (same read) is served, not rejected as stale", async () => {
  const EPOCH = crypto.randomUUID();
  const sent: Array<{ id?: number | string; method?: string; result?: unknown; error?: { code: number } }> = [];
  const node = createNodeConnection({ send: data => sent.push(JSON.parse(data)), close: () => {} }, {
    nodeId: "n", minVersion: 1, maxVersion: 1, capabilities: ["session.provision"],
    ...scriptedCommandHandlers({ provision: async () => ({ provisioned: true }) }),
  });
  const hello = sent.find(frame => frame.method === "node.hello")!;
  // The server replies to hello and immediately delivers a queued command (a reconnect replay).
  node.receive(JSON.stringify({ jsonrpc: "2.0", id: hello.id, result: { version: 1, capabilities: ["session.provision"], epoch: EPOCH } }));
  node.receive(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "session.provision", params: { epoch: EPOCH, sessionId: "s",
    binding: { sourceId: 1, cwd: "/tmp", createdAt: "now", parentSessionId: null }, configuration: { model: null, thinkingLevel: null, task: null } } }));
  await node.ready;
  for (let i = 0; i < 20 && !sent.some(frame => frame.id === 7); i++) await Bun.sleep(1);
  expect(sent.find(frame => frame.id === 7)).toMatchObject({ result: { provisioned: true } });
  node.close();
});
